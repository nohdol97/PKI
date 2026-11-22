// The derivative registry (I04-R1, R2, R4; ARCHITECTURE 5.6). A derivative is
// anything computed from source versions (evidence, knowledge, items, Insights,
// index rows, engine and vector projections, later graph paths, Wiki pages,
// deliveries). Each kind registers what a source change touches (`affected`),
// a row's lineage (the source versions it came from) and how it is removed or
// recomputed (`invalidate`). The registry is one list fixed at construction.
//
// This module also fixes, as types, the names and shapes of the I04 spec's
// design-overview block that later tasks implement: commitDerived (I04-T06, with
// I03-T04's provisional function of the same shape), canonicalTransaction and the
// tombstone entries (I04-T05, ledger lines I04-T10) and ScopePolicy's default
// (I04-T09). I01 and I03 cite these names; change the spec block first.
import { startInvalidation, finishInvalidation, type SourceChangeKind } from "./invalidations.ts";
import { readChangeSeq } from "./revisions.ts";
import type { SqlDriver } from "./sql-driver.ts";
import type { TombstoneReason } from "./tombstones.ts";

/** A scope as I01 normalizes it (sorted, no duplicates); null is unknown, treated as strictest. */
export type AccessScope = readonly string[] | null;

/** Phase-2 order (I04-R2): a lower layer runs before a higher one. */
export const LAYERS = [
  "source",
  "evidence",
  "knowledge",
  "item",
  "insight",
  "delivery",
  "projection",
] as const;
export type Layer = (typeof LAYERS)[number];

/** Phase-2 stages (I04-R2, R12): every canonical kind, then every projection kind. */
const STORAGES = ["canonical", "projection"] as const;

export type SourceChange =
  | { kind: "new-version" | "old-versions-pruned"; sourceId: number; version: number }
  | { kind: "scope-changed"; sourceId: number; from: AccessScope; to: AccessScope }
  | { kind: TombstoneReason; sourceId: number; coversVersion: number; lastRevision: number | null };

/** A canonical id of a derivative; never its content. */
export interface DerivedRef {
  kind: string;
  id: string;
}

/** A product version of a source (never the source system's revision). */
export interface SourceVersionRef {
  sourceId: number;
  version: number;
}

/** Phase 1's collection for one kind: the rows a change touches, with their lineage. */
export type Affected = readonly { ref: DerivedRef; lineage: readonly SourceVersionRef[] }[];

export interface InvalidationContext {
  /** The caller's transaction; a kind never opens its own. */
  tx: SqlDriver;
  /** Every kind's phase-1 collection, by kind name, taken before anything changed. */
  collected: ReadonlyMap<string, Affected>;
  /** This propagation's invalidation record (a re-extraction's `scope-recompute:<id>`, I04-R15). */
  invalidationId: number;
}

export interface InvalidationCounts {
  removed: number;
  recomputed: number;
}

export interface DerivativeKind {
  readonly kind: string;
  readonly layer: Layer;
  /** Kinds of the same layer whose rows this kind points at; this kind runs before them. */
  readonly references: readonly string[];
  /** canonical: in the tombstone transaction; projection: a job run after commit. */
  readonly storage: "canonical" | "projection";
  /** Paths this kind writes under the data directory (none for an in-memory one). */
  readonly dataPaths: readonly string[];
  /** Projection kinds only: an implementation that never holds anything (null engine, empty index). */
  readonly permanentlyAbsent?: true;
  /** Phase 1, before anything is deleted. */
  affected(tx: SqlDriver, change: SourceChange): Affected;
  /** The only input of scope, egress class and fence for a row. */
  lineage(db: SqlDriver, ref: DerivedRef): SourceVersionRef[];
  /** Phase 2; the same input twice gives the same result (the second counts nothing). */
  invalidate(
    ctx: InvalidationContext,
    snapshot: Affected,
    change: SourceChange,
  ): InvalidationCounts;
}

// commitDerived (I04-R11): the only way a derivative is written. The caller (I03's
// result-writing transaction, I03-R6 ③) opens the transaction.
export interface DerivedItem {
  /** A registered kind. */
  kind: string;
  /** The same-row key (V02-R8); a record keeps only its keyed hash (I04-R7). */
  itemKey: string;
  lineage: readonly SourceVersionRef[];
  /** Called only for an item that passed the checks. */
  write(tx: SqlDriver): void;
}

/** One row of scope_policy_drops (I04-T09); no content. */
export interface ScopePolicyDrop {
  sourceId: number;
  version: number;
  kind: string;
  itemKeyHash: string;
  reason: "scope-policy";
  at: string;
}

export type CommitResult =
  /** `dropped`: the records stored in the same transaction. */
  | { status: "committed"; written: number; dropped: readonly ScopePolicyDrop[] }
  /** Nothing written; the job closes superseded. */
  | { status: "stale"; cause?: "missing" | "not-latest" | "covered" | "lineage-covered" };

export interface CommitInput {
  /** The source version the job took as input; null for a job without one. */
  source: SourceVersionRef | null;
  items: readonly DerivedItem[];
}

export type CommitDerived = (tx: SqlDriver, input: CommitInput) => CommitResult;

/**
 * One tombstone-ledger line before the wrapper numbers it (I04-R17). Provisional
 * until I04-T10 writes the ledger: the line's content as R17 lists it.
 */
export interface LedgerLineDraft {
  /** The keyed hash of (connector instance, namespace, external id), I04-R7. */
  identityHash: string;
  coversVersion: number;
  lastRevision: number | null;
  reason: TombstoneReason;
  lifted: boolean;
  at: string;
}

/**
 * The canonical transaction (I04-R17). Every write that may reach a tombstone entry
 * opens one; the entries take this type, which only canonicalTransaction builds.
 */
export interface CanonicalTx extends SqlDriver {
  /** Called by the tombstone entries only; the wrapper numbers and writes the lines. */
  queueLedgerLine(line: LedgerLineDraft): void;
}

export type CanonicalTransaction = <T>(db: SqlDriver, fn: (tx: CanonicalTx) => T) => T;

export interface TombstoneWrite {
  identity: { connectorInstanceId: string; namespace: string; externalId: string };
  reason: TombstoneReason;
  /** The source event's revision; null for the screen's deletion. */
  lastRevision: number | null;
  at: string;
}

export type TombstoneOutcome =
  "created" | "cover-extended" | "reason-changed" | "revision-raised" | "unchanged";

/**
 * The only tombstone write (I04-R9). The entry sets covers_version itself and,
 * on any outcome but `unchanged`, calls propagate in the same transaction.
 */
export type ApplyTombstone = (
  tx: CanonicalTx,
  w: TombstoneWrite,
) => { outcome: TombstoneOutcome; sourceId: number; coversVersion: number };

export type LiftTombstone = (
  tx: CanonicalTx,
  sourceId: number,
  at: string,
) => { outcome: "lifted" | "unchanged" };

export type ScopeComparison = "stricter" | "equal" | "looser" | "incomparable";
export type ScopePurpose = "display" | "search" | "notify" | "answer";

/** The one judge of access scopes (I04-R14); the default arrives with I04-T09. */
export interface ScopePolicy {
  compare(a: AccessScope, b: AccessScope): ScopeComparison;
  strictest(scopes: readonly AccessScope[]): AccessScope | { incomparable: readonly AccessScope[] };
  combinable(scopes: readonly AccessScope[]): boolean;
  /** Read checks only (visible, I04-R13). */
  allows(scopes: readonly AccessScope[], purpose: ScopePurpose): boolean;
}

/** True only when `a` is shown to be as strict as `b`; never implemented apart from compare. */
export function atLeastAsStrict(policy: ScopePolicy, a: AccessScope, b: AccessScope): boolean {
  const c = policy.compare(a, b);
  return c === "stricter" || c === "equal";
}

export class UnregisteredDerivativeError extends Error {
  override name = "UnregisteredDerivativeError";
}

export interface Propagation {
  invalidationId: number;
  removedByKind: Record<string, number>;
  recomputedByKind: Record<string, number>;
}

export interface DerivativeRegistry {
  /** The registered kinds in phase-2 order; frozen. */
  readonly kinds: readonly DerivativeKind[];
  /** Both phases in `tx`, the caller's transaction (no BEGIN of its own), with its record. */
  propagate(tx: SqlDriver, change: SourceChange): Propagation;
  lineage(db: SqlDriver, ref: DerivedRef): SourceVersionRef[];
  /** The refs, in order, whose lineage is all stored and uncovered and whose scopes the policy allows. */
  visible(db: SqlDriver, refs: readonly DerivedRef[], purpose: ScopePurpose): DerivedRef[];
  /** The distinct scopes of the refs' lineage sources (a derivative's scope is never stored). */
  scopesOf(db: SqlDriver, refs: readonly DerivedRef[]): AccessScope[];
}

export interface RegistryOptions {
  kinds: readonly DerivativeKind[];
  policy: ScopePolicy;
  /** The record's time (ISO 8601). */
  now?: () => string;
}

/**
 * Canonical kinds first, then projection-storage kinds (their jobs are registered
 * last, I04-R2, after the tombstone, R12), each in layer order; within a layer a
 * kind runs before the kinds it references.
 */
function phaseOrder(kinds: readonly DerivativeKind[]): DerivativeKind[] {
  const byName = new Map<string, DerivativeKind>();
  for (const k of kinds) {
    if (!(LAYERS as readonly string[]).includes(k.layer)) {
      throw new Error(`derivative kind ${k.kind}: unknown layer ${k.layer}`);
    }
    if (!(STORAGES as readonly string[]).includes(k.storage)) {
      throw new Error(`derivative kind ${k.kind}: unknown storage ${k.storage}`);
    }
    if (byName.has(k.kind)) throw new Error(`derivative kind ${k.kind} is registered twice`);
    if (k.permanentlyAbsent && k.storage !== "projection") {
      throw new Error(`derivative kind ${k.kind}: permanentlyAbsent is for projection kinds`);
    }
    byName.set(k.kind, k);
  }
  for (const k of kinds) {
    for (const r of k.references) {
      const target = byName.get(r);
      if (!target) throw new Error(`derivative kind ${k.kind} references unknown kind ${r}`);
      if (target.layer !== k.layer) {
        throw new Error(`derivative kind ${k.kind} references ${r} of another layer`);
      }
      if (target.storage !== k.storage) {
        throw new Error(`derivative kind ${k.kind} references ${r} of another storage`);
      }
    }
  }
  const stages = STORAGES.flatMap((storage) => LAYERS.map((layer) => ({ storage, layer })));
  const ordered = stages.flatMap(({ storage, layer }) => {
    const pending = kinds.filter((k) => k.storage === storage && k.layer === layer);
    const inStage: DerivativeKind[] = [];
    while (pending.length > 0) {
      // ready: no pending kind still points at it
      const i = pending.findIndex((k) => !pending.some((p) => p.references.includes(k.kind)));
      if (i < 0) {
        throw new Error(`derivative kinds ${pending.map((k) => k.kind).join(", ")} form a cycle`);
      }
      inStage.push(...pending.splice(i, 1));
    }
    return inStage;
  });
  // every kind has a stage: a kind left out would never be invalidated
  if (ordered.length !== kinds.length) {
    throw new Error(`derivative registry ordered ${ordered.length} of ${kinds.length} kinds`);
  }
  return ordered;
}

/** The stored scope text: a JSON array of strings, or one plain value (V01 Connectors). */
export function parseScope(raw: string | null): AccessScope {
  if (raw === null) return null;
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
        return [...new Set(parsed as string[])].sort();
      }
    } catch {
      // not an array: one plain value
    }
  }
  return [raw];
}

const isCount = (n: number) => Number.isInteger(n) && n >= 0;

export function createDerivativeRegistry(options: RegistryOptions): DerivativeRegistry {
  const kinds = Object.freeze(phaseOrder(options.kinds));
  const byName = new Map(kinds.map((k) => [k.kind, k]));
  const now = options.now ?? (() => new Date().toISOString());

  const kindOf = (ref: DerivedRef) => {
    const k = byName.get(ref.kind);
    if (!k) throw new UnregisteredDerivativeError(`no registered derivative kind ${ref.kind}`);
    return k;
  };
  const lineage = (db: SqlDriver, ref: DerivedRef) => kindOf(ref).lineage(db, ref);
  const scopesOfLineage = (db: SqlDriver, versions: readonly SourceVersionRef[]) => {
    const scopes = new Map<string, AccessScope>();
    for (const sourceId of new Set(versions.map((v) => v.sourceId))) {
      const raw = db.all("SELECT access_scope FROM sources WHERE id = ?", [sourceId])[0]
        ?.access_scope as string | null | undefined;
      const scope = parseScope(raw ?? null);
      scopes.set(JSON.stringify(scope), scope);
    }
    return [...scopes.values()];
  };
  // stored, and covered by no tombstone (a lift uncovers nothing: the cover stays)
  const live = (db: SqlDriver, v: SourceVersionRef) =>
    db.all(
      `SELECT 1 FROM source_versions sv WHERE sv.source_id = ? AND sv.version = ?
         AND NOT EXISTS (SELECT 1 FROM tombstones t
                         WHERE t.source_id = sv.source_id AND t.covers_version >= sv.version)`,
      [v.sourceId, v.version],
    ).length === 1;

  return {
    kinds,
    propagate(tx, change) {
      const invalidationId = startInvalidation(tx, {
        changeSeq: readChangeSeq(tx),
        sourceId: change.sourceId,
        changeKind: change.kind satisfies SourceChangeKind,
        at: now(),
      });
      const collected = new Map(kinds.map((k) => [k.kind, k.affected(tx, change)]));
      const removedByKind: Record<string, number> = {};
      const recomputedByKind: Record<string, number> = {};
      const ctx = { tx, collected, invalidationId };
      for (const k of kinds) {
        const { removed, recomputed } = k.invalidate(ctx, collected.get(k.kind) ?? [], change);
        if (!isCount(removed) || !isCount(recomputed)) {
          throw new Error(`derivative kind ${k.kind}: invalid count ${removed}/${recomputed}`);
        }
        removedByKind[k.kind] = removed;
        recomputedByKind[k.kind] = recomputed;
      }
      finishInvalidation(tx, invalidationId, { removedByKind, recomputedByKind });
      return { invalidationId, removedByKind, recomputedByKind };
    },
    lineage,
    visible(db, refs, purpose) {
      return refs.filter((ref) => {
        const versions = lineage(db, ref);
        if (!versions.every((v) => live(db, v))) return false;
        return options.policy.allows(scopesOfLineage(db, versions), purpose);
      });
    },
    scopesOf(db, refs) {
      return scopesOfLineage(
        db,
        refs.flatMap((ref) => lineage(db, ref)),
      );
    },
  };
}
