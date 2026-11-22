// Connector contract, SDK v2 (I01-R3, R25): checkConnector runs a Connector and
// returns the specification violations it finds as codes from a closed list,
// independent of any test framework; connectorContract wraps it as a vitest
// suite. The suppression rules of I01-R25 keep structurally linked violations to
// one code each. Codes only: no message nor record content leaves the check.
import {
  ChangeSchema,
  ChangeSetSchema,
  CONNECTOR_SDK_VERSION,
  blocksValid,
  rejectedPositionValid,
  type Connector,
} from "@pki/contracts";
import { describe, expect, it } from "vitest";

/** I01-R25's table, in its order. */
export const CONNECTOR_VIOLATION_CODES = [
  "manifest-invalid",
  "sdk-version-mismatch",
  "responds-before-init",
  "unhealthy-after-init",
  "health-threw",
  "limit-exceeded",
  "page-size-dependent",
  "duplicate-identity",
  "no-progress",
  "changes-after-final-cursor",
  "record-schema",
  "invalid-blocks",
  "capability-deletes",
  "capability-access-scope",
  "revision-not-increasing",
  "tombstone-revision-below-upsert",
  "rescan-deletion-missing",
  "rejected-position-invalid",
  "get-document-mismatch",
  "get-document-unknown",
  "abort-ignored",
] as const;
export type ConnectorViolationCode = (typeof CONNECTOR_VIOLATION_CODES)[number];
/** A not-implemented placeholder yields `not-implemented` alone, instead of violations. */
export type ConnectorCheckCode = ConnectorViolationCode | "not-implemented";

export interface ConnectorScenario {
  /** Initializes the Connector. */
  config: unknown;
  /**
   * The origin after it changed: a new instance initialized with it reads from a
   * null cursor, as a rescan after a restart.
   */
  later?: unknown;
  /**
   * Pages one read may take before the check gives up and throws (a scenario
   * error, not a violation: unique cursors are progress). PAGE_CAP by default.
   */
  maxPages?: number;
  /**
   * The Connector reads a file whose every line is a version (the JSONL collector, I01-R23): a
   * source may be upserted more than once in a read, each time with a greater revision. Only
   * then is a repeated upsert not `duplicate-identity`; an equal or lower revision still is.
   */
  versionedSources?: boolean;
}

type Caps = {
  incremental: boolean;
  deletes: boolean;
  accessScope: boolean;
  deletionsOnRescan: boolean;
};
type Identity = string;
type Seen = {
  kind: string;
  record?: Record<string, unknown> | undefined;
  accessScope?: unknown;
  /** A scope change after a tombstone in the same read: the source is still gone. */
  tombstoned?: boolean;
};
const isTombstone = (seen: Seen | undefined) =>
  seen?.kind === "delete" || seen?.kind === "access-revoked" || seen?.tombstoned === true;

const CAPABILITY_KEYS = [
  "incremental",
  "deletes",
  "accessScope",
  "fullRescan",
  "deletionsOnRescan",
] as const;
/** Default bound on the pages of one read (provisional, ConnectorScenario.maxPages). */
const PAGE_CAP = 10_000;
const UNKNOWN_ID = "contract-unknown-external-id";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const identityOf = (v: Record<string, unknown>): Identity | null =>
  typeof v.namespace === "string" && typeof v.externalId === "string"
    ? JSON.stringify([v.namespace, v.externalId])
    : null;
/** JSON with sorted keys: records compare by value, whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}
const signal = () => new AbortController().signal;
const settles = async (call: () => Promise<unknown>) => {
  try {
    await call();
    return true;
  } catch {
    return false;
  }
};

interface Read {
  /** Every change delivered, in order. */
  changes: unknown[];
  /** The last change per identity. */
  last: Map<Identity, Seen>;
  /** The last upsert's record per identity. */
  lastUpsert: Map<Identity, Record<string, unknown>>;
  finalCursor: string;
  /** Read to `hasMore: false` without a stall or a malformed page. */
  complete: boolean;
  /** limit-exceeded, duplicate-identity or no-progress happened in it. */
  pageFault: boolean;
}

class Check {
  readonly found = new Set<ConnectorViolationCode>();
  readonly caps: Caps;
  readonly maxPages: number;
  readonly versioned: boolean;
  constructor(caps: Caps, maxPages: number, versioned = false) {
    this.caps = caps;
    this.maxPages = maxPages;
    this.versioned = versioned;
  }

  add(code: ConnectorViolationCode) {
    this.found.add(code);
  }

  /** One read from `null`; `upserts` carries the last upsert revision per identity across reads. */
  async read(connector: Connector, limit: number, upserts: Map<Identity, number>): Promise<Read> {
    const read: Read = {
      changes: [],
      last: new Map(),
      lastUpsert: new Map(),
      finalCursor: "",
      complete: false,
      pageFault: false,
    };
    const delivered = new Set<Identity>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let n = 0; ; n++) {
      if (n >= this.maxPages) {
        throw new Error(
          `a contract read took more than ${this.maxPages} pages; raise the scenario's maxPages`,
        );
      }
      let page: unknown;
      try {
        page = await connector.getChanges(cursor, { limit, signal: signal() });
      } catch (error) {
        throw new Error("getChanges failed during a contract read; check the scenario", {
          cause: error,
        });
      }
      const shaped = this.pageShape(page);
      if (!shaped) return read;
      const next = shaped.nextCursor;
      // A page whose next cursor was already seen is the stall itself: its
      // (repeated) changes are not folded, so they are not duplicates too.
      if (shaped.hasMore) {
        if (cursors.has(next) || next === cursor) break;
      }
      if (shaped.changes.length > limit) {
        this.add("limit-exceeded");
        read.pageFault = true;
      }
      for (const change of shaped.changes) this.change(change, read, delivered, upserts);
      for (const { at } of shaped.rejected) {
        if (!rejectedPositionValid(at)) this.add("rejected-position-invalid");
      }
      if (!shaped.hasMore) {
        read.finalCursor = next;
        read.complete = true;
        return read;
      }
      cursors.add(next);
      cursor = next;
    }
    this.add("no-progress");
    read.pageFault = true;
    return read;
  }

  /** The page itself, its changes and rejections left for later; a malformed page ends the read. */
  pageShape(page: unknown) {
    const shape =
      isObject(page) &&
      Array.isArray(page.changes) &&
      ChangeSetSchema.safeParse({ ...page, changes: [] });
    if (!shape || !shape.success) {
      this.add("record-schema");
      return null;
    }
    return { ...shape.data, changes: (page as { changes: unknown[] }).changes };
  }

  change(change: unknown, read: Read, delivered: Set<Identity>, upserts: Map<Identity, number>) {
    read.changes.push(change);
    if (!isObject(change)) return this.add("record-schema");
    if (change.kind === "upsert" && isObject(change.record)) {
      const record = change.record;
      // The manifest is at CONNECTOR_SDK_VERSION here, so this is also "differs from it".
      if (record.schemaVersion !== CONNECTOR_SDK_VERSION) this.add("sdk-version-mismatch");
      const parsed = ChangeSchema.safeParse({
        ...change,
        record: { ...record, schemaVersion: CONNECTOR_SDK_VERSION },
      });
      if (!parsed.success) this.add("record-schema");
      else if (parsed.data.kind === "upsert") {
        const { body, blocks, accessScope } = parsed.data.record;
        if (blocks && !blocksValid(body, blocks)) this.add("invalid-blocks");
        if (this.caps.accessScope !== (accessScope !== undefined))
          this.add("capability-access-scope");
      }
      const identity = identityOf(record);
      if (identity === null) return;
      if (delivered.has(identity)) {
        const before = read.lastUpsert.get(identity)?.revision;
        const newer =
          this.versioned &&
          typeof record.revision === "number" &&
          typeof before === "number" &&
          record.revision > before;
        if (!newer) {
          this.add("duplicate-identity");
          read.pageFault = true;
        }
      }
      delivered.add(identity);
      read.last.set(identity, { kind: "upsert", record });
      read.lastUpsert.set(identity, record);
      if (typeof record.revision === "number") upserts.set(identity, record.revision);
      return;
    }
    const parsed = ChangeSchema.safeParse(change);
    if (!parsed.success || parsed.data.kind === "upsert") return this.add("record-schema");
    const event = parsed.data;
    const identity = identityOf(event) as Identity;
    const before = read.last.get(identity);
    read.last.set(
      identity,
      event.kind === "scope-change"
        ? {
            kind: event.kind,
            record: read.lastUpsert.get(identity),
            accessScope: event.accessScope,
            tombstoned: isTombstone(before),
          }
        : { kind: event.kind },
    );
    if (event.kind === "scope-change") {
      if (!this.caps.accessScope) this.add("capability-access-scope");
      return;
    }
    if (!this.caps.deletes) this.add("capability-deletes");
    const upserted = upserts.get(identity);
    if (upserted !== undefined && event.revision < upserted) {
      this.add("tombstone-revision-below-upsert");
    }
  }
}

function manifestOf(connector: Connector) {
  try {
    return connector.manifest as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Runs the Connector the scenario sets up and returns the violation codes found,
 * once each, in CONNECTOR_VIOLATION_CODES order. A scenario that does not
 * initialize it, or a read that throws, is the caller's error and throws.
 */
export async function checkConnector(
  create: () => Connector,
  scenario: ConnectorScenario,
): Promise<ConnectorCheckCode[]> {
  const { maxPages = PAGE_CAP } = scenario;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new Error("the scenario's maxPages must be a positive integer");
  }
  const subject = create();
  const manifest = manifestOf(subject);
  if (!isObject(manifest)) return ["manifest-invalid"];
  const capabilities = isObject(manifest.capabilities) ? manifest.capabilities : null;
  const manifestFaults: ConnectorViolationCode[] = [];
  // The manifest check does not look at the version (I01-R25 suppression rules).
  if (
    typeof manifest.type !== "string" ||
    !/\S/.test(manifest.type) ||
    capabilities === null ||
    CAPABILITY_KEYS.some((k) => typeof capabilities[k] !== "boolean") ||
    (capabilities.deletionsOnRescan === true &&
      !(capabilities.deletes === true && capabilities.fullRescan === true))
  ) {
    manifestFaults.push("manifest-invalid");
  }
  // Behaviour is not judged against an SDK version the Connector does not implement.
  if (manifest.schemaVersion !== CONNECTOR_SDK_VERSION) {
    return [...manifestFaults, "sdk-version-mismatch"];
  }
  if (capabilities === null) return ["manifest-invalid"];
  const check = new Check(
    {
      incremental: capabilities.incremental === true,
      deletes: capabilities.deletes === true,
      accessScope: capabilities.accessScope === true,
      deletionsOnRescan: capabilities.deletionsOnRescan === true,
    },
    maxPages,
    scenario.versionedSources === true,
  );
  for (const code of manifestFaults) check.add(code);

  const fresh = create();
  const answeredEarly =
    (await settles(() => fresh.getChanges(null, { limit: 1, signal: signal() }))) ||
    (await settles(() => fresh.getDocument({ namespace: "", externalId: UNKNOWN_ID })));

  try {
    await subject.initialize(scenario.config);
  } catch (error) {
    if (error instanceof Error && error.name === "ConnectorNotImplementedError") {
      return ["not-implemented"];
    }
    throw new Error("the Connector did not initialize with the scenario's config", {
      cause: error,
    });
  }
  if (answeredEarly) check.add("responds-before-init");

  try {
    const health: unknown = await subject.healthCheck();
    if (!isObject(health) || health.state !== "ok") check.add("unhealthy-after-init");
  } catch {
    check.add("health-threw"); // and so not unhealthy-after-init
  }

  const upserts = new Map<Identity, number>();
  const whole = await check.read(subject, 1000, upserts);
  const paged = await check.read(subject, 1, new Map());
  if (whole.complete && paged.complete && !whole.pageFault && !paged.pageFault) {
    const sorted = (r: Read) => r.changes.map(canonical).sort();
    if (canonical(sorted(whole)) !== canonical(sorted(paged))) check.add("page-size-dependent");
  }

  if (whole.complete) {
    await finalCursor(check, subject, whole);
    await documents(check, subject, whole);
    if (scenario.later !== undefined) await rescan(check, create, scenario.later, whole, upserts);
  }

  const aborted = new AbortController();
  aborted.abort();
  if (await settles(() => subject.getChanges(null, { limit: 1, signal: aborted.signal }))) {
    check.add("abort-ignored");
  }

  return CONNECTOR_VIOLATION_CODES.filter((code) => check.found.has(code));
}

async function finalCursor(check: Check, connector: Connector, whole: Read) {
  if (!check.caps.incremental) return;
  try {
    const next = await connector.getChanges(whole.finalCursor, { limit: 1000, signal: signal() });
    if (
      !isObject(next) ||
      !Array.isArray(next.changes) ||
      next.changes.length > 0 ||
      next.hasMore
    ) {
      check.add("changes-after-final-cursor");
    }
  } catch {
    check.add("changes-after-final-cursor");
  }
}

async function documents(check: Check, connector: Connector, whole: Read) {
  for (const [identity, seen] of whole.last) {
    const [namespace, externalId] = JSON.parse(identity) as [string, string];
    try {
      if (!documentMatches(seen, await connector.getDocument({ namespace, externalId }))) {
        check.add("get-document-mismatch");
      }
    } catch {
      check.add("get-document-mismatch");
    }
  }
  const first = [...whole.last.keys()][0];
  const probes = [{ namespace: "", externalId: UNKNOWN_ID }];
  if (first) {
    const [namespace, externalId] = JSON.parse(first) as [string, string];
    probes.push({ namespace: `${namespace}-contract-other`, externalId });
  }
  for (const probe of probes) {
    try {
      if ((await connector.getDocument(probe)) !== null) check.add("get-document-unknown");
    } catch {
      check.add("get-document-unknown");
    }
  }
}

/**
 * What getDocument owes for an identity, by its last change: the upsert's record;
 * null after a tombstone, also when a late scope change follows it; after a
 * scope change, the last upsert's content (its revision unspecified) with the
 * event's scope; any record when the read had no upsert of it.
 */
function documentMatches(seen: Seen, doc: unknown): boolean {
  if (seen.kind === "upsert") return canonical(doc) === canonical(seen.record);
  if (seen.kind !== "scope-change") return doc === null;
  if (seen.tombstoned) return doc === null; // a late scope change does not revive it
  if (!isObject(doc)) return false;
  if (!seen.record) return true; // a scope change for a source this read never upserted
  return (
    content(doc) === content(seen.record) &&
    canonical(doc.accessScope) === canonical(seen.accessScope)
  );
}

/** The record without what may differ at the same revision (scope, R10 `scope-updated`). */
const content = (record: Record<string, unknown> | undefined) => {
  const rest = { ...record };
  delete rest.revision;
  delete rest.accessScope;
  return canonical(rest);
};

async function rescan(
  check: Check,
  create: () => Connector,
  later: unknown,
  whole: Read,
  upserts: Map<Identity, number>,
) {
  const connector = create();
  try {
    await connector.initialize(later);
  } catch (error) {
    throw new Error("the Connector did not initialize with the scenario's later config", {
      cause: error,
    });
  }
  const after = await check.read(connector, 1000, upserts);
  if (!after.complete) return;
  const deleted = new Set<Identity>();
  const upserted = new Map<Identity, Record<string, unknown>>();
  for (const change of after.changes) {
    if (!isObject(change)) continue;
    if (change.kind === "upsert" && isObject(change.record)) {
      const identity = identityOf(change.record);
      if (identity) upserted.set(identity, change.record);
    } else if (change.kind === "delete") {
      const identity = identityOf(change);
      if (identity) deleted.add(identity);
    }
  }
  for (const [identity, before] of whole.lastUpsert) {
    const now = upserted.get(identity);
    if (now) {
      if (
        content(now) !== content(before) &&
        !((now.revision as number) > (before.revision as number))
      ) {
        check.add("revision-not-increasing");
      }
      continue;
    }
    // Alive at the end of the first read: its last change was not a tombstone.
    const alive = !isTombstone(whole.last.get(identity));
    if (check.caps.deletionsOnRescan && alive && !deleted.has(identity)) {
      check.add("rescan-deletion-missing");
    }
  }
}

/** The contract as a vitest suite: the Connector the scenario sets up has no violation. */
export function connectorContract(
  name: string,
  create: () => Connector,
  scenario: ConnectorScenario,
): void {
  describe(`Connector contract: ${name}`, () => {
    it("checkConnector finds no violation", async () => {
      expect(await checkConnector(create, scenario)).toEqual([]);
    });
  });
}
