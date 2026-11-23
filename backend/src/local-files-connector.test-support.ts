// Test support of the `local-files` connector tests (I02B-T03a): a real temporary folder, the canonical
// index over an in-memory database, a fake clock and an in-process normalizer stand-in. Not product code.
import { SourceRecordSchema, type Change, type Connector, type SourceRecord } from "@pki/contracts";
import { nodeBoundaryFs, type BoundaryFs } from "@pki/connector-sdk";
import {
  normalizeDocument,
  NORMALIZER_VERSION,
  type DocumentFormat,
} from "@pki/document-normalize";
import {
  createLocalFileIndex,
  insertLocation,
  listLocations,
  newLocalId,
  migrate,
  recordTombstone,
  registerConnectorInstance,
  saveSourceRecord,
  closeLocation,
  reopenLocation,
  type LocalFileIndex,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createLocalFilesConnector,
  type LocalFilesPorts,
} from "./adapters/local-files-connector.ts";
import type { LocalFilesLimits, LocalNormalizeResult, LocalPassReport } from "@pki/contracts";

export const DEFAULT_LIMITS: LocalFilesLimits = {
  maxFileBytes: 1_000_000,
  settleMs: 1_000,
  pageBudgetMs: 60_000,
  walk: { maxFilesPerLocation: 1_000, maxDepth: 8, maxRelativePathChars: 256 },
  normalize: { maxHeapMb: 256, maxExternalMemoryBytes: 512 * 1024 ** 2 },
  deletionBrake: { ratio: 0.5, minFiles: 20 },
  revoke: { maxPerTransaction: 100, lockWaitMs: 5_000 },
  watch: { quietMs: 2_000, maxWaitMs: 30_000 },
};

/** What a test hooks into the file system calls (lstat, open) of the path boundary. */
export interface FsHooks {
  beforeOpen?: (path: string, nth: number) => void;
  /** Paths whose `open` fails as a program holding them would (`EBUSY`). */
  locked: Set<string>;
  /** After `arm`, the second `lstat` and the `open` of the path answer as the other file. */
  redirect?: { path: string; to: string; lstats: number };
}

export function hookedFs(hooks: FsHooks): BoundaryFs {
  const opens = new Map<string, number>();
  const target = (path: string) =>
    hooks.redirect && path === hooks.redirect.path && hooks.redirect.lstats > 1
      ? hooks.redirect.to
      : path;
  return {
    ...nodeBoundaryFs,
    async lstat(path) {
      if (hooks.redirect && path === hooks.redirect.path) hooks.redirect.lstats += 1;
      return nodeBoundaryFs.lstat(target(path));
    },
    async open(path, flags) {
      const nth = (opens.get(path) ?? 0) + 1;
      opens.set(path, nth);
      hooks.beforeOpen?.(path, nth);
      if (hooks.locked.has(path)) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return nodeBoundaryFs.open(target(path), flags);
    },
  };
}

export interface World {
  root: string;
  outside: string;
  dataDir: string;
  db: SqlDriver;
  index: LocalFileIndex;
  locationId: string;
  clock: { t: number };
  ports: LocalFilesPorts;
  hooks: FsHooks;
  limits: LocalFilesLimits;
  /** Names the normalizer was called with, in order. */
  calls: string[];
  /** Set to change what the normalizer answers; undefined falls through to the real one. */
  normalizeAs: (name: string, nth: number) => LocalNormalizeResult | undefined;
  broken: { value: boolean };
  reports: LocalPassReport[];
  connector: Connector;
  cursor: string | null;
  version: { value: number };
  write(rel: string, content: string | Uint8Array): void;
  /** One sync: the clock moves on, every page is read; the changes it announced. */
  sync(opts?: { limit?: number; cursor?: string | null }): Promise<Change[]>;
  /** Two syncs: a new or changed file passes the settle condition (I02B-R15). */
  settle(): Promise<Change[]>;
  /** The location leaves the readable states, as the user's pause does (I02B-R10). */
  pause(): void;
  /** The location is read again. */
  resume(): void;
  close(): void;
}

const FORMAT_OF: Record<string, DocumentFormat> = {
  md: "markdown",
  txt: "txt",
  docx: "docx",
  csv: "csv",
};

export function world(options: { limits?: Partial<LocalFilesLimits> } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pki-local-files-")));
  const root = join(base, "docs");
  const outside = join(base, "outside");
  const dataDir = join(root, "pki-data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outside);
  const db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "local-files", "local-files");
  const stat = statSync(root, { bigint: true });
  const locationId = newLocalId();
  insertLocation(db, {
    id: locationId,
    type: "folder",
    displayPath: root,
    realPath: root,
    rootDev: stat.dev.toString(),
    rootIno: stat.ino.toString(),
    createdAt: "2026-11-23T00:00:00.000Z",
  });
  const index = createLocalFileIndex(db);
  const clock = { t: Date.now() + 10_000 };
  const hooks: FsHooks = { locked: new Set() };
  const calls: string[] = [];
  const reports: LocalPassReport[] = [];
  const broken = { value: false };
  const version = { value: NORMALIZER_VERSION };
  const limits: LocalFilesLimits = {
    ...DEFAULT_LIMITS,
    walk: { ...DEFAULT_LIMITS.walk },
    normalize: { ...DEFAULT_LIMITS.normalize },
    deletionBrake: { ...DEFAULT_LIMITS.deletionBrake },
    revoke: { ...DEFAULT_LIMITS.revoke },
    watch: { ...DEFAULT_LIMITS.watch },
    ...options.limits,
  };
  const nth = new Map<string, number>();
  const w = {
    root,
    outside,
    dataDir,
    db,
    index,
    locationId,
    clock,
    hooks,
    limits,
    calls,
    broken,
    reports,
    version,
    cursor: null as string | null,
    normalizeAs: (): LocalNormalizeResult | undefined => undefined,
  } as unknown as World;
  w.ports = {
    index,
    locations: () => listLocations(db),
    normalizer: {
      async normalize(input, opts) {
        calls.push(input.name);
        const n = (nth.get(input.name) ?? 0) + 1;
        nth.set(input.name, n);
        const forced = w.normalizeAs(input.name, n);
        if (forced) return forced;
        const ext = input.name.split(".").pop() ?? "";
        const format = FORMAT_OF[ext];
        const result = await normalizeDocument(
          { kind: "bytes", bytes: input.bytes, name: input.name, ...(format ? { format } : {}) },
          opts.limits ? { limits: opts.limits } : {},
        );
        return result as unknown as LocalNormalizeResult;
      },
      unavailable: () => broken.value,
      recheck: async () => !broken.value,
    },
    get normalizerVersion() {
      return version.value;
    },
    excluded: () => [dataDir],
    limits: () => w.limits,
    now: () => clock.t,
    setLocationState: (id, state, reason, expected) =>
      state === "active"
        ? reopenLocation(db, id, reason, expected)
        : closeLocation(db, id, state, reason, expected),
    report: (r) => reports.push(r),
    fs: hookedFs(hooks),
  };
  w.connector = createLocalFilesConnector(() => w.ports);
  w.write = (rel, content) => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path, old, old);
  };
  let started = false;
  w.sync = async (opts = {}) => {
    if (!started) await w.connector.initialize({});
    started = true;
    clock.t += 1_500;
    const all: Change[] = [];
    let cursor = opts.cursor === undefined ? w.cursor : opts.cursor;
    for (let pages = 0; pages < 1_000; pages++) {
      const page = await w.connector.getChanges(cursor, {
        limit: opts.limit ?? 100,
        signal: new AbortController().signal,
      });
      all.push(...page.changes);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    w.cursor = cursor;
    return all;
  };
  w.settle = async () => {
    await w.sync();
    return w.sync();
  };
  w.pause = () => {
    closeLocation(db, locationId, "paused", null);
  };
  w.resume = () => {
    reopenLocation(db, locationId);
  };
  w.close = () => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  };
  return w;
}

export const upserts = (changes: readonly Change[]): SourceRecord[] =>
  changes.flatMap((c) => (c.kind === "upsert" ? [SourceRecordSchema.parse(c.record)] : []));
export const deletes = (changes: readonly Change[]) => changes.filter((c) => c.kind === "delete");

/** What the sync job does with an announced upsert: the source row, with the record's revision. */
export function storeUpserts(w: World, changes: readonly Change[]): void {
  for (const r of upserts(changes)) {
    saveSourceRecord(w.db, "local-files", {
      namespace: r.namespace,
      externalId: r.externalId,
      title: r.title,
      body: r.body,
      revision: r.revision,
    });
  }
}

/** The source row a sync would store for the entry, then the user's deletion of it (the tombstone trigger scrubs). */
export function userDeletes(w: World, externalId: string): void {
  const saved = saveSourceRecord(w.db, "local-files", {
    namespace: w.locationId,
    externalId,
    title: "t",
    body: "b",
  });
  if (saved.status !== "created") throw new Error(saved.status);
  recordTombstone(w.db, saved.sourceId, {
    reason: "user-deleted",
    lastRevision: null,
    at: "2026-11-23T00:00:00.000Z",
  });
}
