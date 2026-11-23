// Automatic promotion to `verified` (S01-R9, provisional decision 3): the one place that decides
// whether a candidate fact or relation is promoted, and whether a promotion the policy made is taken
// back. The conditions are the spec's five; confidence is not one of them and is never read here
// (R10). Every status change goes through the lifecycle gate's two policy entries
// (`automatedLifecycle.autoVerify` and `autoVerifyLost`), which write the history line; this file
// writes no row. The transaction is the caller's (the extract write, the propagation).
//
// The setting `semantic.autoVerify` is OFF unless it reads exactly `on`: with it off nothing here
// reads a row or writes a line (dark launch, root AGENTS.md 13-5).
//
//   1. the setting is on
//   2. the epistemic type is `explicit`
//   3. current evidence from two independent sources (a source's versions are one source, two sources
//      with the same content hash are one, a source a tombstone covers is not counted)
//   4. the row's type definition (fact kind or relation type) is `verified`
//   5. a fact kind whose value count is `one` has no other value in a valid row of the item (the
//      rule's "유효", S01-R15: not superseded or rejected, and current evidence or a user input)
//
// A promoted row is taken back to the state it had before (the gate reads it from the history) when
// condition 3 or 5 no longer holds. Not when the setting is switched off, not when the type
// definition changes (a type with live rows cannot be retired, R19), and never for a row the user
// decided or wrote (R12: `user-override`, answered before any condition is looked at).
import {
  automatedLifecycle,
  isUserDecided,
  otherValidValues,
  listOntologyElements,
  readFact,
  readRelation,
  readSetting,
  validitySetByUser,
  type AutoVerifyLoss,
  type EntryRef,
  type Outcome,
  type SqlDriver,
} from "@pki/storage";

export const AUTO_VERIFY_SETTING = "semantic.autoVerify";

export type AutoVerifyCondition =
  "disabled" | "not-explicit" | "independent-sources" | "type-unverified" | "conflicting-value";

/** The gate's outcomes, and the answer that names the conditions a candidate did not meet. */
export type AutoVerifyOutcome =
  | Outcome
  | { status: "refused"; reason: "auto-verify-unmet"; unmet: readonly AutoVerifyCondition[] };

/** Condition 1: exactly `on` (the same reading as `providers.cli.background`). */
export const readAutoVerify = (db: SqlDriver): boolean =>
  readSetting(db, AUTO_VERIFY_SETTING) === "on";

/** The key exists (the setting was written, on or off): a promotion may exist whose revert is still owed. */
const everEnabled = (db: SqlDriver): boolean => readSetting(db, AUTO_VERIFY_SETTING) !== undefined;

const unmet = (...conditions: AutoVerifyCondition[]): AutoVerifyOutcome => ({
  status: "refused",
  reason: "auto-verify-unmet",
  unmet: conditions,
});

/** Condition 3: the distinct contents of the current versions, a covered source left out. */
function independentSources(tx: SqlDriver, ref: EntryRef): number {
  const column = ref.kind === "fact" ? "fact_id" : "relation_id";
  return tx.all(
    `SELECT count(DISTINCT v.content_hash) AS n
     FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
     WHERE e.${column} = ?
       AND v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id)
       AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.source_id = v.source_id AND t.covers_version >= v.version)`,
    [ref.id],
  )[0]?.n as number;
}

/** Condition 4 and the rule condition 5 reads: the `verified` definition of the row's type. */
function definitionOf(tx: SqlDriver, ref: EntryRef, name: string) {
  const elementKind = ref.kind === "fact" ? "fact-kind" : "relation-type";
  return listOntologyElements(tx).find(
    (e) => e.elementKind === elementKind && e.name === name && e.status === "verified",
  );
}

/**
 * Condition 5 holds when this returns true: another valid value in the same slot of the item (the one
 * shared judgement `otherValidValues`, S02-R20; it answers nothing for a kind that is not a `one` kind, and
 * leaves out a value a SUPERSEDES link replaced). Same item only: the merge group is the conflict list's.
 */
const conflictingValue = (tx: SqlDriver, fact: { id: number }): boolean =>
  otherValidValues(tx, fact.id, "item").length > 0;

/**
 * Judges one fact or relation. A candidate is promoted when every condition holds, else the answer
 * names the ones that do not (in the order above). A verified row the policy promoted is taken back
 * when condition 3 or 5 is lost. An item is never touched (provisional decision 12), a row the user
 * decided or wrote (a direct add's creation line is a user action) is `user-override` before any
 * condition is read (R12), and any other status is
 * `unchanged`. The history line carries `at` (the caller's time) when given.
 */
export function assessAutoVerify(tx: SqlDriver, ref: EntryRef, at?: string): AutoVerifyOutcome {
  const row =
    ref.kind === "fact"
      ? readFact(tx, ref.id)
      : ref.kind === "relation"
        ? readRelation(tx, ref.id)
        : undefined;
  if (ref.kind === "item") {
    const exists = tx.all("SELECT 1 FROM items WHERE id = ?", [ref.id]).length === 1;
    return { status: "refused", reason: exists ? "invalid-transition" : "not-found" };
  }
  if (!row) return { status: "refused", reason: "not-found" };
  if (isUserDecided(tx, ref)) {
    return { status: "refused", reason: "user-override" };
  }
  // a candidate whose interval the user fixed is not a target of the promotion (S02-R17); the gate's own
  // test ignores that line, and a promotion the policy already made is still taken back as before
  if (row.status === "candidate" && validitySetByUser(tx, ref)) {
    return { status: "refused", reason: "user-override" };
  }
  // Off (or never written): a candidate is not promoted, but a row the policy once promoted is still
  // taken back when it loses condition 3 or 5 (R9). The hooks never call this while the key was never written.
  const enabled = readAutoVerify(tx);
  if (!enabled && row.status === "candidate") return unmet("disabled");
  if (row.status !== "candidate" && row.status !== "verified") return { status: "unchanged" };

  const name = "type" in row ? row.type : row.kind;
  const definition = definitionOf(tx, ref, name);
  const conflict = "value" in row && conflictingValue(tx, row);
  const sources = independentSources(tx, ref);

  if (row.status === "verified") {
    const lost: AutoVerifyLoss[] = [
      ...(sources < 2 ? (["independent-sources"] as const) : []),
      ...(conflict ? (["conflicting-value"] as const) : []),
    ];
    const first = lost[0];
    return first === undefined
      ? { status: "unchanged" }
      : automatedLifecycle.autoVerifyLost(tx, ref, first, at);
  }
  const missing: AutoVerifyCondition[] = [
    ...(row.epistemic === "explicit" ? [] : (["not-explicit"] as const)),
    ...(sources >= 2 ? [] : (["independent-sources"] as const)),
    ...(definition ? [] : (["type-unverified"] as const)),
    ...(conflict ? (["conflicting-value"] as const) : []),
  ];
  return missing.length > 0 ? unmet(...missing) : automatedLifecycle.autoVerify(tx, ref, at);
}

/**
 * After extraction wrote ALL the rows of one answer (the last item of the result, in the same
 * transaction): the written facts' items are judged per (item, kind), so every fact of the kind is
 * judged once on the final state of the answer, and the written relations each once. Judging after
 * each row would promote a value and take it back again when the next row of the same answer
 * names a rival. Does nothing while the key was never written.
 */
export function assessAfterExtraction(
  tx: SqlDriver,
  written: { factIds: readonly number[]; relationIds: readonly number[] },
  at?: string,
): void {
  if (!everEnabled(tx)) return;
  const groups = new Map<string, { itemId: number; kind: string }>();
  for (const id of [...written.factIds].sort((a, b) => a - b)) {
    const fact = readFact(tx, id);
    if (fact)
      groups.set(`${fact.itemId}\u0000${fact.kind}`, { itemId: fact.itemId, kind: fact.kind });
  }
  for (const { itemId, kind } of groups.values()) assessItemFacts(tx, [itemId], at, kind);
  assessRelations(tx, written.relationIds, at);
}

/** The rows a change reached: the facts of these items (all kinds) and these relations, as far as still stored. */
interface Reached {
  itemIds: readonly number[];
  relationIds: readonly number[];
}

/**
 * After a propagation took evidence away or put a version past it: the facts of the items the
 * propagation reached (the rival of a deleted value included: its item is named before the row goes)
 * and the relations it reached. Does nothing while the key was never written; with the setting off
 * only the restores happen (see `assessAutoVerify`).
 */
export function assessAfterPropagation(tx: SqlDriver, reached: Reached, at?: string): void {
  if (!everEnabled(tx)) return;
  assessItemFacts(tx, reached.itemIds, at);
  assessRelations(tx, reached.relationIds, at);
}

/**
 * After a user action (decide, undo, add, replace): the items and relations the action bore on are
 * judged. A value the user wrote or approved is a valid row (R15), so it can end a promoted sibling's
 * condition 5; an undo can give a row back to the policy while its grounds are gone. The caller is the
 * API layer, after a successful action (backend `judgeAgain`, and the split route), in the action's
 * transaction. Does nothing while the key was never written.
 */
export function assessAfterUserAction(tx: SqlDriver, reached: Reached, at?: string): void {
  if (!everEnabled(tx)) return;
  assessItemFacts(tx, reached.itemIds, at);
  assessRelations(tx, reached.relationIds, at);
}

function assessRelations(tx: SqlDriver, ids: readonly number[], at?: string) {
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    assessAutoVerify(tx, { kind: "relation", id }, at);
  }
}

/** Judges the facts of these items (of one kind when given), ascending by id, those still stored. */
function assessItemFacts(tx: SqlDriver, itemIds: readonly number[], at?: string, kind?: string) {
  for (const itemId of [...new Set(itemIds)].sort((a, b) => a - b)) {
    const ids = tx
      .all(
        `SELECT id FROM facts WHERE item_id = ?${kind === undefined ? "" : " AND kind = ?"} ORDER BY id`,
        kind === undefined ? [itemId] : [itemId, kind],
      )
      .map((r) => r.id as number);
    for (const id of ids) assessAutoVerify(tx, { kind: "fact", id }, at);
  }
}
