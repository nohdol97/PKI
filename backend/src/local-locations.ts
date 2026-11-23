// The location API's logic (I02B-R5, R36, R37, R40): the approval of a folder (the path check, the
// one-time ticket outside a test build, one row stored only after the check passed), the list the
// screen reads, and the limits as settings. Nothing here reads a file's content. The routes are
// server.ts's; the composition point (composition.ts) builds this with the canonical database.
import { checkApproval, type ApprovalContext, type BoundaryFs } from "@pki/connector-sdk";
import type {
  LocalApprovalRejectionCode,
  LocalApprovalRequest,
  LocalConfirmDeletionsRequest,
  LocalLocationIdRequest,
  LocalReimportRequest,
  LocalRevokeRequest,
  LocalSkippedRequest,
  LocalSkippedResponse,
  LocalRelinkRequest,
  LocalFilesSettings,
  LocalFilesSettingsPatch,
  LocalLocationInfo,
  LocalLocationList,
  LocalPassReport,
} from "@pki/contracts";
import { errorClass, log, type BuildKind } from "@pki/providers";
import type { LocalRevoke, RevokeAnswer } from "./local-revoke.ts";
import {
  closeLocation,
  confirmDeletions,
  insertLocation,
  listLocations,
  newLocalId,
  readSetting,
  reimportEntry,
  relinkLocation,
  reopenLocation,
  writeSetting,
  type LocalFileIndex,
  type LocalLocation,
  type SqlDriver,
} from "@pki/storage";

/** I02-A's default for the largest file read (`DEFAULT_LIMITS.maxFileBytes`), repeated here so the settings do not import the parser. */
const DEFAULT_MAX_FILE_BYTES = 52_428_800;

/** The defaults of "한도 기본값" (spec); every one is provisional and a setting (I02B-R40). */
export const LOCAL_FILES_DEFAULTS: LocalFilesSettings = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  settleMs: 2_000,
  pageBudgetMs: 20_000,
  walk: { maxFilesPerLocation: 50_000, maxDepth: 32, maxRelativePathChars: 1_024 },
  normalize: { timeoutMs: 60_000, maxHeapMb: 1_536, maxExternalMemoryBytes: 1_610_612_736 },
  deletionBrake: { ratio: 0.5, minFiles: 20 },
  revoke: { maxPerTransaction: 100, lockWaitMs: 5_000 },
  watch: { quietMs: 2_000, maxWaitMs: 30_000 },
};

const KEY = "localFiles.";
const positive = (text: string | undefined): number | undefined => {
  if (text === undefined || !/^[1-9][0-9]*$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
};

/** A positive decimal such as `0.5` or `3`; anything else is undefined. */
const positiveDecimal = (text: string | undefined): number | undefined => {
  if (text === undefined || !/^(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The limits as stored; a missing or damaged value is the default, never a guess. */
export function readLocalFilesSettings(db: SqlDriver): LocalFilesSettings {
  const read = (name: string, fallback: number) =>
    positive(readSetting(db, KEY + name)) ?? fallback;
  const d = LOCAL_FILES_DEFAULTS;
  return {
    maxFileBytes: read("maxFileBytes", d.maxFileBytes),
    settleMs: read("settleMs", d.settleMs),
    pageBudgetMs: read("pageBudgetMs", d.pageBudgetMs),
    walk: {
      maxFilesPerLocation: read("walk.maxFilesPerLocation", d.walk.maxFilesPerLocation),
      maxDepth: read("walk.maxDepth", d.walk.maxDepth),
      maxRelativePathChars: read("walk.maxRelativePathChars", d.walk.maxRelativePathChars),
    },
    normalize: {
      timeoutMs: read("normalize.timeoutMs", d.normalize.timeoutMs),
      maxHeapMb: read("normalize.maxHeapMb", d.normalize.maxHeapMb),
      maxExternalMemoryBytes: read(
        "normalize.maxExternalMemoryBytes",
        d.normalize.maxExternalMemoryBytes,
      ),
    },
    deletionBrake: {
      ratio: positiveDecimal(readSetting(db, `${KEY}deletionBrake.ratio`)) ?? d.deletionBrake.ratio,
      minFiles: read("deletionBrake.minFiles", d.deletionBrake.minFiles),
    },
    revoke: {
      maxPerTransaction: read("revoke.maxPerTransaction", d.revoke.maxPerTransaction),
      lockWaitMs: read("revoke.lockWaitMs", d.revoke.lockWaitMs),
    },
    watch: {
      quietMs: read("watch.quietMs", d.watch.quietMs),
      maxWaitMs: read("watch.maxWaitMs", d.watch.maxWaitMs),
    },
  };
}

/** The settings a patch names, as (key, value) pairs. */
function changes(patch: LocalFilesSettingsPatch): [string, number][] {
  const out: [string, number][] = [];
  for (const name of ["maxFileBytes", "settleMs", "pageBudgetMs"] as const) {
    const value = patch[name];
    if (value !== undefined) out.push([name, value]);
  }
  for (const group of ["walk", "normalize", "deletionBrake", "revoke", "watch"] as const) {
    for (const [name, value] of Object.entries(patch[group] ?? {})) {
      if (value !== undefined) out.push([`${group}.${name}`, value]);
    }
  }
  return out;
}

/** The two limits whose lowering would make the walk lose what it holds (I02B-R40, spec D28). */
const LOWERING_DROPS_ENTRIES: ReadonlySet<string> = new Set([
  "walk.maxDepth",
  "walk.maxRelativePathChars",
]);

// --- the one-time ticket (I02B-R37) ------------------------------------------------------------------

export const TICKET_TTL_MS = 5 * 60_000;
const TICKETS_HELD = 16;

export interface ApprovalTickets {
  /** The shell's main process registers a picked path under a ticket it made; the backend never makes one. */
  register(input: { ticket: string; type: "folder"; path: string }): void;
  /** The path a ticket stands for, once: the ticket is gone after it, valid or not. */
  redeem(ticket: string, type: "folder"): string | undefined;
}

export function createApprovalTickets(
  options: { now?: () => number; ttlMs?: number } = {},
): ApprovalTickets {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? TICKET_TTL_MS;
  const held = new Map<string, { type: "folder"; path: string; expires: number }>();
  return {
    register({ ticket, type, path }) {
      held.set(ticket, { type, path, expires: now() + ttl });
      // a picker that is never answered does not grow the table: the oldest goes first
      while (held.size > TICKETS_HELD) held.delete(held.keys().next().value as string);
    },
    redeem(ticket, type) {
      const found = held.get(ticket);
      held.delete(ticket);
      return found && found.type === type && found.expires > now() ? found.path : undefined;
    },
  };
}

/** The shell's `location-ticket` message on the parent channel (exactly that shape), or undefined. */
export function locationTicket(
  data: unknown,
): { ticket: string; type: "folder"; path: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (Object.keys(data).sort().join(",") !== "kind,path,ticket,type") return undefined;
  const { type, ticket, kind, path } = data as Record<string, unknown>;
  const sized = (v: unknown, min: number, max: number): v is string =>
    typeof v === "string" && v.length >= min && v.length <= max;
  if (type !== "location-ticket" || kind !== "folder") return undefined;
  if (!sized(ticket, 16, 256) || !sized(path, 1, 4096)) return undefined;
  return { ticket, type: "folder", path };
}

// --- the handler ---------------------------------------------------------------------------------------

export type ApprovalAnswer =
  LocalLocationInfo | { error: "approval-rejected"; code: LocalApprovalRejectionCode };

/** A relink's answer: the location, a refused check, an unknown location, or one that is not in a state that relinks (I02B-R9). */
export type RelinkAnswer =
  | LocalLocationInfo
  | { error: "approval-rejected"; code: LocalApprovalRejectionCode }
  | { error: "not-found" }
  | { error: "bad-request" };

/** What a lifecycle action answers: the location as the list shows it, or why nothing changed. */
export type ActionAnswer =
  | LocalLocationInfo
  | { error: "not-found" }
  | { error: "bad-request" }
  | { error: "count-mismatch" };

export type ReimportAnswer =
  { outcome: "queued" } | { error: "not-found" } | { error: "not-lifted" };

export interface LocalLocations {
  approve(request: LocalApprovalRequest): Promise<ApprovalAnswer>;
  relink(request: LocalRelinkRequest): Promise<RelinkAnswer>;
  /** The location is not read (I02B-R10); from `active`, `unavailable` and `needs-confirmation`. */
  pause(request: LocalLocationIdRequest): ActionAnswer;
  /** A paused location is read again; the next pass decides its state (I02B-R7). */
  resume(request: LocalLocationIdRequest): ActionAnswer;
  /** The skipped files of a location, with the user's deletions from the last pass (I02B-R33, R36). */
  skipped(request: LocalSkippedRequest): LocalSkippedResponse | { error: "not-found" };
  /** A skipped or user-deleted file is read again; a user deletion needs its tombstone lifted (I02B-R33). */
  reimport(request: LocalReimportRequest): ReimportAnswer;
  /** Every location is walked from the start at the next sync (I02B-R13); instance-wide, whichever location is named. */
  rescan(request: LocalLocationIdRequest): { outcome: "queued" } | { error: "not-found" };
  /** The approval is withdrawn: every source of the location is deleted as the user's deletion (I02B-R10, R49). */
  revoke(request: LocalRevokeRequest): Promise<RevokeAnswer | { error: "connector-unavailable" }>;
  /** The held deletions are confirmed by the count the user saw (I02B-R8). */
  confirmDeletions(request: LocalConfirmDeletionsRequest): ActionAnswer;
  list(): LocalLocationList;
  settings(): LocalFilesSettings;
  writeSettings(
    patch: LocalFilesSettingsPatch,
  ): LocalFilesSettings | { error: "limit-would-delete" };
}

export interface LocalLocationsOptions {
  db: SqlDriver;
  index: Pick<LocalFileIndex, "entriesOfLocation">;
  /** The folders a location may not be or lie in: the data directory, the shell's user-data folder. */
  forbidden: readonly string[];
  /** Read from the build, never from a request: outside a test build a typed path is refused (I02B-R37). */
  buildKind: BuildKind;
  tickets: ApprovalTickets;
  /** Called after an approval stored its row: the composition point registers the first sync. */
  onApproved: () => void;
  normalizerUnavailable: () => boolean;
  /** What the last finished pass learned (the counts the list shows that the index does not hold). */
  lastReport?: () => LocalPassReport | undefined;
  /** The revocation (local-revoke.ts); without it a revoke answers connector-unavailable. */
  revoker?: LocalRevoke;
  /** Whether the driver watches the location (I02B-R20, R38); without a driver none is. */
  watching?: (locationId: string) => boolean;
  /** Told after a change of the set of read locations, so the driver places its watchers. */
  changed?: () => void;
  /** Starts a full sync of the `local-files` instance; the composition point binds the manager. */
  rescan?: () => void;
  now?: () => number;
  fs?: BoundaryFs;
}

export function createLocalLocations(options: LocalLocationsOptions): LocalLocations {
  const { db, index } = options;
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  /** The driver places its watchers for the new set of read locations; its failure is no failure of the change. */
  const changed = () => {
    try {
      options.changed?.();
    } catch (error) {
      log("local-watch-refresh-failed", { error: errorClass(error) });
    }
  };

  const rejected = (code: LocalApprovalRejectionCode): ApprovalAnswer => ({
    error: "approval-rejected",
    code,
  });

  /** The path a request stands for: a ticket's, or a typed one only where the build has an input field for it (I02B-R37). */
  function pathOf(request: { ticket?: string | undefined; path?: string | undefined }) {
    if (request.ticket !== undefined) return options.tickets.redeem(request.ticket, "folder");
    return options.buildKind !== "production" ? request.path : undefined;
  }

  async function approveOne(request: LocalApprovalRequest): Promise<ApprovalAnswer> {
    const path = pathOf(request);
    if (path === undefined) return rejected("ticket-required");

    const context: ApprovalContext = {
      forbidden: options.forbidden,
      locations: listLocations(db),
      // only folders are approved in this release (I02B-D2); a file kind comes with its API
      isDocumentFile: () => false,
      ...(options.fs ? { fs: options.fs } : {}),
    };
    const checked = await checkApproval({ kind: request.type, path }, context);
    if (!checked.ok) return rejected(checked.code);

    const id = newLocalId();
    insertLocation(db, {
      id,
      type: request.type,
      displayPath: checked.displayPath,
      realPath: checked.realPath,
      rootDev: checked.dev,
      rootIno: checked.ino,
      createdAt: new Date(now()).toISOString(),
    });
    try {
      options.onApproved();
    } catch (error) {
      // the location stays; the hourly sync finds it. Class only: a message can name a path
      log("local-sync-register-failed", { error: errorClass(error) });
    }
    const stored = listLocations(db).find((l) => l.id === id) as LocalLocation;
    changed();
    return view(stored);
  }

  async function relinkOne(request: LocalRelinkRequest): Promise<RelinkAnswer> {
    const location = listLocations(db).find((l) => l.id === request.locationId);
    if (!location) return { error: "not-found" };
    if (location.state !== "unavailable" && location.state !== "needs-confirmation") {
      return { error: "bad-request" };
    }
    const path = pathOf(request);
    if (path === undefined) return rejected("ticket-required");
    // the same checks as an approval; the location itself is left out of the overlap check (I02B-R9)
    const checked = await checkApproval(
      { kind: "folder", path },
      {
        forbidden: options.forbidden,
        locations: listLocations(db),
        ignoreLocationId: location.id,
        isDocumentFile: () => false,
        ...(options.fs ? { fs: options.fs } : {}),
      },
    );
    if (!checked.ok) return rejected(checked.code);
    relinkLocation(db, location.id, {
      displayPath: checked.displayPath,
      realPath: checked.realPath,
      rootDev: checked.dev,
      rootIno: checked.ino,
    });
    try {
      options.onApproved();
    } catch (error) {
      log("local-sync-register-failed", { error: errorClass(error) });
    }
    changed();
    return view(listLocations(db).find((l) => l.id === location.id) as LocalLocation);
  }

  /** Runs a change on a location in one of `states`; the answer is the location afterwards. */
  function act(
    id: string,
    states: readonly LocalLocation["state"][] | undefined,
    change: () => unknown,
  ): ActionAnswer {
    const location = listLocations(db).find((l) => l.id === id);
    if (!location) return { error: "not-found" };
    if (states && !states.includes(location.state)) return { error: "bad-request" };
    if (change() === "count-mismatch") return { error: "count-mismatch" };
    changed();
    return view(listLocations(db).find((l) => l.id === id) as LocalLocation);
  }

  function view(location: LocalLocation): LocalLocationInfo {
    const entries = index.entriesOfLocation(location.id);
    const report = options.lastReport?.()?.locations.find((r) => r.locationId === location.id);
    const at = options.lastReport?.()?.at;
    return {
      id: location.id,
      type: location.type,
      displayPath: location.displayPath,
      state: location.state,
      stateReason: location.stateReason,
      counts: {
        tracked: entries.filter((e) => e.state === "present").length,
        skipped: entries.filter((e) => e.state === "skipped" || e.state === "forgotten").length,
        ignored: report?.ignored ?? 0,
        pendingDeletes: entries.filter((e) => e.pendingDelete === 1).length,
      },
      limitExceeded: report?.limitExceeded ?? location.limitExceeded,
      lastPassAt:
        location.lastPassAt ?? (report && at !== undefined ? new Date(at).toISOString() : null),
      watching: options.watching?.(location.id) ?? false,
    };
  }

  const holdsEntries = () =>
    listLocations(db).some((l) =>
      index.entriesOfLocation(l.id).some((e) => e.state === "present" || e.state === "skipped"),
    );

  return {
    approve(request) {
      // one approval at a time: two requests for the same place cannot both pass the overlap check
      const run = queue.then(() => approveOne(request));
      queue = run.catch(() => undefined);
      return run;
    },
    relink(request) {
      const run = queue.then(() => relinkOne(request));
      queue = run.catch(() => undefined);
      return run;
    },
    pause: ({ locationId }) =>
      act(locationId, ["active", "unavailable", "needs-confirmation"], () =>
        closeLocation(db, locationId, "paused", null),
      ),
    resume: ({ locationId }) => act(locationId, ["paused"], () => reopenLocation(db, locationId)),
    confirmDeletions: ({ locationId, count }) =>
      act(
        locationId,
        undefined,
        () => confirmDeletions(db, locationId, count).ok || "count-mismatch",
      ),
    rescan({ locationId }) {
      if (!listLocations(db).some((l) => l.id === locationId)) return { error: "not-found" };
      options.rescan?.();
      return { outcome: "queued" };
    },
    async revoke(request) {
      if (!options.revoker) return { error: "connector-unavailable" };
      const answer = await options.revoker.revoke(request);
      changed();
      return answer;
    },
    skipped({ locationId, offset = 0, limit = 100 }) {
      if (!listLocations(db).some((l) => l.id === locationId)) return { error: "not-found" };
      // a user deletion keeps no path in the index (R33): the last pass's report is where it is named
      const forgotten = (options.lastReport?.()?.locations ?? [])
        .filter((r) => r.locationId === locationId)
        .flatMap((r) => r.forgottenPaths)
        .map((relativePath) => ({ relativePath, reason: "user-deleted" as const, since: null }));
      const skipped = index
        .entriesOfLocation(locationId)
        .filter((e) => e.state === "skipped" && e.relativePath !== null)
        .map((e) => ({
          relativePath: e.relativePath as string,
          reason: e.skipReason as LocalSkippedResponse["items"][number]["reason"],
          since: e.skippedAt,
        }));
      const all = [...skipped, ...forgotten].sort((a, b) =>
        a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
      );
      return { items: all.slice(offset, offset + limit), total: all.length };
    },
    reimport({ locationId, relativePath }) {
      const result = reimportEntry(db, locationId, relativePath);
      if (result.ok) {
        try {
          options.onApproved(); // a sync reads it: the same registration an approval makes
        } catch (error) {
          log("local-sync-register-failed", { error: errorClass(error) });
        }
        return { outcome: "queued" };
      }
      return { error: result.reason };
    },
    list: () => ({
      locations: listLocations(db).map(view),
      normalizerUnavailable: options.normalizerUnavailable(),
      limits: readLocalFilesSettings(db),
    }),
    settings: () => readLocalFilesSettings(db),
    writeSettings(patch) {
      const current = readLocalFilesSettings(db);
      const wanted = changes(patch);
      const lowering = wanted.some(([key, value]) => {
        if (!LOWERING_DROPS_ENTRIES.has(key)) return false;
        const [, name] = key.split(".") as [string, "maxDepth" | "maxRelativePathChars"];
        return value < current.walk[name];
      });
      if (lowering && holdsEntries()) return { error: "limit-would-delete" };
      db.transaction(() => {
        for (const [key, value] of wanted) writeSetting(db, KEY + key, String(value));
      });
      return readLocalFilesSettings(db);
    },
  };
}
