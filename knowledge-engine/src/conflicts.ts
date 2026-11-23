// The conflict rule (S02-R19) and the policy's dispute on a new contradiction (S02-R20). In a slot that holds
// one value (kind of `one` cardinality, same merge group, same kind, same tag), two valid facts with different
// values are judged pairwise by their valid intervals alone — never by observed time:
//   both starts known and the intervals do not overlap          -> SUPERSEDES, the later interval supersedes;
//   one end open and the other starts later (both starts known) -> SUPERSEDES, the later start supersedes;
//   anything else                                               -> CONTRADICTS (smaller id first).
// The rule changes no row. Its links (`rule`) are diffed against the stored ones, never rebuilt, so a link's id
// stays stable for the Insight rows resting on it and "newly created" is the one trigger of a dispute.
// No LLM is called. A pair whose two sources the scope policy will not put together gets no link.
import {
  automatedLifecycle,
  deleteAssertionLinks,
  insertAssertionLink,
  isValidRow,
  linksOfFacts,
  listEvidence,
  listEvidenceVersions,
  readSetting,
  rowLineage,
  slotRivals,
  unionOfVersions,
  withGroups,
  type KnowledgeStatus,
  type LinkType,
  type MembershipListener,
  type MembershipScope,
  type SqlDriver,
} from "@pki/storage";

export const AUTO_DISPUTE_SETTING = "semantic.autoDispute";
/** Whether the policy disputes a verified fact on a new contradiction (default OFF, decision 8). */
export const readAutoDispute = (db: SqlDriver): boolean =>
  readSetting(db, AUTO_DISPUTE_SETTING) === "on";

export interface ConflictOutcome {
  created: number;
  removed: number;
  disputesRaised: number;
}

interface Interval {
  from: string | null;
  until: string | null;
}

/** The link that judges two facts' intervals: who supersedes whom, or a contradiction (smaller id first). */
function judge(
  a: { id: number } & Interval,
  b: { id: number } & Interval,
): { type: LinkType; from: number; to: number } {
  const supersedes = (later: typeof a, earlier: typeof a) => ({
    type: "SUPERSEDES" as const,
    from: later.id,
    to: earlier.id,
  });
  if (a.from !== null && b.from !== null) {
    if (a.until !== null && a.until <= b.from) return supersedes(b, a);
    if (b.until !== null && b.until <= a.from) return supersedes(a, b);
    if (a.until === null && b.from > a.from) return supersedes(b, a);
    if (b.until === null && a.from > b.from) return supersedes(a, b);
  }
  return a.id < b.id
    ? { type: "CONTRADICTS", from: a.id, to: b.id }
    : { type: "CONTRADICTS", from: b.id, to: a.id };
}

/** The lowest-numbered source version among a fact's current evidence, or undefined when it has none. */
function currentBasis(tx: SqlDriver, factId: number) {
  const ids = listEvidence(tx, { factId })
    .filter((e) => e.current)
    .map((e) => e.id);
  return listEvidenceVersions(tx, ids)[0];
}

const pairKey = (type: string, from: number, to: number) => `${type}:${from}:${to}`;

/**
 * Judges the slots of the items (widened to their merge groups) again: deletes the `rule` links that no
 * longer hold, writes the missing ones, and, when the setting is on, disputes the verified side of a
 * contradiction that is new and sits on one item. Pairs already joined by a `propagation` or `user` link are
 * left alone (those are not recomputed).
 */
export function refreshConflicts(
  tx: SqlDriver,
  touched: readonly number[],
  scope: Pick<MembershipScope, "combinable">,
  options: { at?: string } = {},
): ConflictOutcome {
  const items = withGroups(tx, touched);
  if (items.length === 0) return { created: 0, removed: 0, disputesRaised: 0 };
  const facts = tx
    .all(
      `SELECT id, item_id, status, valid_at, valid_until FROM facts
       WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
      [JSON.stringify(items)],
    )
    .map((r) => ({
      id: r.id as number,
      itemId: r.item_id as number,
      status: r.status as KnowledgeStatus,
      from: r.valid_at as string | null,
      until: r.valid_until as string | null,
    }));
  const byId = new Map(facts.map((f) => [f.id, f]));
  const stored = linksOfFacts(
    tx,
    facts.map((f) => f.id),
  );
  const fixed = new Set(
    stored
      .filter((l) => l.createdBy !== "rule")
      .flatMap((l) => [`${l.fromFactId}:${l.toFactId}`, `${l.toFactId}:${l.fromFactId}`]),
  );
  const wanted = new Map<string, { type: LinkType; from: number; to: number }>();
  for (const f of facts) {
    // slotRivals does not judge the asked fact's own status
    if (!isValidRow(tx, { kind: "fact", id: f.id }, f.status)) continue;
    for (const otherId of slotRivals(tx, f.id, "group")) {
      const other = byId.get(otherId);
      if (!other || other.id < f.id) continue;
      if (fixed.has(`${f.id}:${other.id}`)) continue;
      const lineage = unionOfVersions(
        rowLineage(tx, { kind: "fact", id: f.id }),
        rowLineage(tx, { kind: "fact", id: other.id }),
      );
      if (!scope.combinable(lineage)) continue;
      const link = judge(f, other);
      wanted.set(pairKey(link.type, link.from, link.to), link);
    }
  }
  const existing = stored.filter((l) => l.createdBy === "rule");
  const stale = existing.filter((l) => !wanted.has(pairKey(l.type, l.fromFactId, l.toFactId)));
  deleteAssertionLinks(
    tx,
    stale.map((l) => l.id),
  );
  const kept = new Set(existing.map((l) => pairKey(l.type, l.fromFactId, l.toFactId)));
  const at = options.at ?? new Date().toISOString();
  let created = 0;
  let disputesRaised = 0;
  const dispute = readAutoDispute(tx);
  for (const [key, link] of wanted) {
    if (kept.has(key)) continue;
    const { created: isNew } = insertAssertionLink(tx, {
      type: link.type,
      fromFactId: link.from,
      toFactId: link.to,
      createdBy: "rule",
      at,
    });
    if (!isNew) continue;
    created++;
    if (!dispute || link.type !== "CONTRADICTS") continue;
    const [x, y] = [byId.get(link.from), byId.get(link.to)];
    // two items of one group: the merge made the mismatch, the dispute would make the merge change a row's state
    if (!x || !y || x.itemId !== y.itemId) continue;
    for (const [side, other] of [
      [x, y],
      [y, x],
    ] as const) {
      const basis = currentBasis(tx, other.id);
      if (!basis) continue;
      const result = automatedLifecycle.raiseDispute(
        tx,
        { kind: "fact", id: side.id },
        basis,
        options.at,
        "contradiction",
      );
      if (result.status === "applied") disputesRaised++;
    }
  }
  return { created, removed: stale.length, disputesRaised };
}

/** The membership receiver: a merge, an unmerge or a split changes who shares a slot (S02-R13). */
export const conflictsReceiver: MembershipListener = (tx, change, scope) => {
  const { created, removed } = refreshConflicts(tx, change.items, scope);
  scope.recomputed?.("assertion-link", created + removed);
};
