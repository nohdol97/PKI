// Entity groups (S02-R11, R13, R14): the one place that reads a merge group. A merge is one line
// (`item_merges`: the member is the representative's), no row moves, so every reader that wants a
// group as one item asks here. Only lines that are `active` count: a line rests (`active = 0`) while
// the lineage of its whole group cannot be put together under the scope policy (R13, provisional
// decision 22: the unit is the group, found through resting lines too, and all its lines rest or none).
//
// Two views of a group are kept apart on purpose. The reads (`representativeOf`, `membersOf`,
// `lineageOf`) are for readers and follow active lines only. The group as a whole
// (`componentOf`, `rootOf`) follows every line, resting ones included: it is what the user's merge
// resolves its two ends against, what the scope judgement takes the lineage of, and what the kind
// `entity-merge` joins around a deleted item.
//
// The notification of a changed membership (R13) is declared here too: the actions that change which
// item a row belongs to (a merge, an unmerge, a group resting or waking, a split) call the fixed list
// of listeners the composition root hands them, in the same transaction; a listener that throws
// rolls the whole action back.
import type { SourceVersionRef } from "./derivatives.ts";
import { rowLineage, unionOfVersions } from "./row-lineage.ts";
import type { SqlDriver } from "./sql-driver.ts";

export type ItemId = number;

/** A fact or relation a split moved (S02-T07 fills `movedRows`; a merge, an unmerge and a rest leave it empty). */
export interface MovedRow {
  kind: "fact" | "relation";
  id: number;
}

/** The items an action reached, and the rows whose item changed (a split). */
export interface MembershipChange {
  items: readonly ItemId[];
  movedRows: readonly MovedRow[];
}

/** What a receiver may ask of the scope policy: the acting side's own, the user's entry's or the propagation's (I04-R14). */
export interface MembershipScope {
  combinable(lineage: readonly SourceVersionRef[]): boolean;
  /**
   * A receiver says how many rows of a derivative kind it changed, when the acting side keeps a tally: a
   * propagation counts them in its record, so the record's count of a kind includes what a receiver changed.
   */
  recomputed?(kind: string, count: number): void;
}

/**
 * A receiver of the notification. It deletes or recomputes what rests on an item (a rule's Insight, a
 * check line) and nothing else; it is reviewed when it is registered, as a derivative kind is, because
 * a throw inside a deletion's propagation rolls that propagation back. `scope` is the acting side's
 * policy, for a receiver that recomputes something the policy may refuse.
 */
export type MembershipListener = (
  tx: SqlDriver,
  change: MembershipChange,
  scope: MembershipScope,
) => void;

/** Calls every listener in the list's order, handing each the action's scope; an empty change is not announced. */
export function notifyMembership(
  tx: SqlDriver,
  listeners: readonly MembershipListener[],
  change: MembershipChange,
  scope: MembershipScope,
): void {
  if (change.items.length === 0 && change.movedRows.length === 0) return;
  const sorted = {
    items: [...new Set(change.items)].sort((a, b) => a - b),
    movedRows: change.movedRows,
  };
  for (const listener of listeners) listener(tx, sorted, scope);
}

/** The group as readers see it (only active lines count). */
export interface EntityGroups {
  /** The representative of the item's group; the item itself when it is alone or its group rests. */
  representativeOf(db: SqlDriver, item: ItemId): ItemId;
  /** The representative and every member of the group, ascending; just the item when alone or resting. */
  membersOf(db: SqlDriver, item: ItemId): readonly ItemId[];
  /** The source versions of every item of the group, each once. */
  lineageOf(db: SqlDriver, item: ItemId): readonly SourceVersionRef[];
}

export interface MergeLine {
  id: number;
  memberId: ItemId;
  representativeId: ItemId;
  active: boolean;
}

const lineOf = (db: SqlDriver, memberId: ItemId) =>
  db.all("SELECT representative_id, active FROM item_merges WHERE member_id = ?", [memberId])[0];

/** Walks up from `item` while the line is accepted; a cycle (never written) ends the walk. */
function walkUp(db: SqlDriver, item: ItemId, accept: (active: number) => boolean): ItemId {
  const seen = new Set<ItemId>([item]);
  let at = item;
  for (;;) {
    const line = lineOf(db, at);
    if (!line || !accept(line.active as number)) return at;
    at = line.representative_id as ItemId;
    if (seen.has(at)) return at;
    seen.add(at);
  }
}

/** The item at the top of the chain, through resting lines too: where a merge's end is resolved. */
export const rootOf = (db: SqlDriver, item: ItemId): ItemId => walkUp(db, item, () => true);

/** Every item connected to `item` by a line, resting or not, `item` included, ascending. */
export function componentOf(db: SqlDriver, item: ItemId): ItemId[] {
  const seen = new Set<ItemId>([item]);
  const pending: ItemId[] = [item];
  while (pending.length > 0) {
    const at = pending.pop() as ItemId;
    for (const r of db.all(
      "SELECT member_id, representative_id FROM item_merges WHERE member_id = ? OR representative_id = ?",
      [at, at],
    )) {
      for (const other of [r.member_id as ItemId, r.representative_id as ItemId]) {
        if (!seen.has(other)) {
          seen.add(other);
          pending.push(other);
        }
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** One merge line by its id, with the state it rests in; undefined when none is stored. */
export function readMergeLine(db: SqlDriver, id: number): MergeLine | undefined {
  const r = db.all(
    "SELECT id, member_id, representative_id, active FROM item_merges WHERE id = ?",
    [id],
  )[0];
  return r
    ? {
        id: r.id as number,
        memberId: r.member_id as ItemId,
        representativeId: r.representative_id as ItemId,
        active: r.active === 1,
      }
    : undefined;
}

/** The lines among `items` (both ends inside the list). */
export function linesAmong(db: SqlDriver, items: readonly ItemId[]): MergeLine[] {
  const set = new Set(items);
  return items
    .flatMap((member) =>
      db.all(
        "SELECT id, member_id, representative_id, active FROM item_merges WHERE member_id = ?",
        [member],
      ),
    )
    .filter((r) => set.has(r.representative_id as ItemId))
    .map((r) => ({
      id: r.id as number,
      memberId: r.member_id as ItemId,
      representativeId: r.representative_id as ItemId,
      active: r.active === 1,
    }))
    .sort((a, b) => a.id - b.id);
}

/** The source versions of the items, each once. */
export const lineageOfItems = (db: SqlDriver, items: readonly ItemId[]): SourceVersionRef[] =>
  unionOfVersions(...items.map((id) => rowLineage(db, { kind: "item", id })));

export const entityGroups: EntityGroups = {
  representativeOf: (db, item) => walkUp(db, item, (active) => active === 1),

  membersOf(db, item) {
    const root = walkUp(db, item, (active) => active === 1);
    const members = new Set<ItemId>([root]);
    const pending: ItemId[] = [root];
    while (pending.length > 0) {
      const at = pending.pop() as ItemId;
      for (const r of db.all(
        "SELECT member_id FROM item_merges WHERE representative_id = ? AND active = 1",
        [at],
      )) {
        const member = r.member_id as ItemId;
        if (!members.has(member)) {
          members.add(member);
          pending.push(member);
        }
      }
    }
    return [...members].sort((a, b) => a - b);
  },

  lineageOf(db, item) {
    return lineageOfItems(db, entityGroups.membersOf(db, item));
  },
};

/**
 * The items and every member of their groups, ascending, each once (active lines only, as `membersOf`).
 * One read finds which of the items are on a line at all, so a long list of lone items costs one query.
 */
export function withGroups(db: SqlDriver, items: readonly ItemId[]): ItemId[] {
  const all = new Set<ItemId>(items);
  if (items.length === 0) return [];
  const ids = JSON.stringify([...all]);
  const onLine = new Set<ItemId>();
  for (const r of db.all(
    `SELECT member_id, representative_id FROM item_merges
     WHERE active = 1 AND (member_id IN (SELECT value FROM json_each(?))
       OR representative_id IN (SELECT value FROM json_each(?)))`,
    [ids, ids],
  )) {
    for (const id of [r.member_id as ItemId, r.representative_id as ItemId]) {
      if (all.has(id)) onLine.add(id);
    }
  }
  for (const id of onLine) for (const m of entityGroups.membersOf(db, id)) all.add(m);
  return [...all].sort((a, b) => a - b);
}

/**
 * Judges the groups the items belong to again (R13): the lineage of a whole group, resting lines
 * followed, is asked of `combinable` once, and every line of the group takes the answer. Lines whose
 * state changed are counted, and the items of the groups that changed are returned (ascending), for the
 * notification. A group without a line is not a group.
 */
export function rejudgeGroups(
  tx: SqlDriver,
  items: readonly ItemId[],
  combinable: (lineage: readonly SourceVersionRef[]) => boolean,
): { changedLines: number; items: ItemId[] } {
  const judged = new Set<ItemId>();
  const reached = new Set<ItemId>();
  let changedLines = 0;
  for (const start of [...new Set(items)].sort((a, b) => a - b)) {
    if (judged.has(start)) continue;
    const group = componentOf(tx, start);
    for (const id of group) judged.add(id);
    const lines = linesAmong(tx, group);
    if (lines.length === 0) continue;
    const wanted = combinable(lineageOfItems(tx, group)) ? 1 : 0;
    let changed = 0;
    for (const line of lines) {
      if ((line.active ? 1 : 0) === wanted) continue;
      changed += tx.run("UPDATE item_merges SET active = ? WHERE id = ?", [
        wanted,
        line.id,
      ]).changes;
    }
    if (changed > 0) {
      changedLines += changed;
      for (const id of group) reached.add(id);
    }
  }
  return { changedLines, items: [...reached].sort((a, b) => a - b) };
}
