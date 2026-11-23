// The user's entry to entity resolution (S02-R11, R12, R16): merge, unmerge and the distinct mark. Like the
// type definitions' operations it travels inside `userDecisions` (as `entities`), so the one lint-guarded
// name is the only way to it: extraction, propagation and the job runner cannot import it, and the only
// code that writes an `item_merges` line is here (module-boundary lint, `lifecycle.actor-boundary`).
//
// A merge moves no row. It writes one line, "the member's representative is this item", after both ends
// are read as the tops of their groups (resting lines followed), and one history line on each of those two
// items (actor `user`, action `merge`, the two states the same, the line's id in `batch`). An unmerge
// deletes one line whatever was stacked on it and writes the same kind of line. Neither changes a status,
// an epistemic type or any fact, relation or evidence row; the history lines are state-neutral, so the
// undo and the protection of an approval read past them (semantic-lifecycle.ts `STATE_NEUTRAL_ACTIONS`).
// The groups' lines rest or wake by the scope policy (`rejudgeGroups`), and every action that changes who
// belongs to a group tells the fixed list of listeners in its own transaction (R13).
//
// The transaction is the caller's. The scope policy is a constructor input: `combinable` answers for a
// lineage in the caller's database (the composition root binds the registry's).
import type { SourceVersionRef } from "./derivatives.ts";
import {
  componentOf,
  lineageOfItems,
  linesAmong,
  notifyMembership,
  type MembershipScope,
  rejudgeGroups,
  rootOf,
  type ItemId,
  type MembershipListener,
} from "./entity-groups.ts";
import { unionOfVersions } from "./row-lineage.ts";
import { readRow, writeLine } from "./semantic-lifecycle.ts";
import type { SqlDriver } from "./sql-driver.ts";

export type MergeRefusal = "not-found" | "type-mismatch" | "already-merged" | "scope-refused";

export type MergeResult =
  { status: "applied"; mergeId: number } | { status: "refused"; reason: MergeRefusal };

export type UnmergeResult =
  | { status: "applied"; member: ItemId; representative: ItemId }
  | { status: "refused"; reason: "not-found" };

export type DistinctResult =
  { status: "applied" | "unchanged" } | { status: "refused"; reason: "not-found" | "same-item" };

export type SplitRefusal = "not-found" | "row-not-on-item" | "nothing-selected" | "nothing-left";

export type SplitResult =
  | { status: "applied"; created: ItemId; movedFacts: number[]; movedRelations: number[] }
  | { status: "refused"; reason: SplitRefusal };

export interface EntityDecisions {
  /**
   * Merges two items. Either may be a member: both are read as the tops of their groups and the one line
   * goes from the first's top to the second's (R11). A distinct mark between the two items, or between
   * the two tops, is deleted (a later user judgement wins), and so is every candidate between the two
   * groups. `type-mismatch` when the two items' types differ, `already-merged` when they share a group
   * (resting lines followed), `scope-refused` when the lineage of the two groups together cannot be put
   * together. Nothing is written on a refusal.
   */
  merge(tx: SqlDriver, member: ItemId, into: ItemId, at?: string): MergeResult;
  /**
   * Deletes one merge line (R12), a resting one included, whatever was stacked on it: the member and
   * what hangs below it leave the group. With `keepDistinct` a distinct mark is left between the line's
   * two ends. The two resulting groups are judged again against the scope policy.
   */
  unmerge(tx: SqlDriver, mergeId: number, keepDistinct: boolean, at?: string): UnmergeResult;
  /**
   * Moves the chosen facts and relations of an item to a new item the user names (S02-R15): the new item is a
   * direct add (user-written, verified, no lineage) of the original's type; only the rows' item numbers
   * change (a relation's end that was the original item becomes the new item). One `item_split_moves` line per
   * row, a distinct mark between the two items, a state-neutral `split` line on each, and the membership
   * notification with the moved rows. `row-not-on-item` for a row that is not the item's (or not stored),
   * `nothing-selected` for none, `nothing-left` when every fact and relation of the item is chosen. Nothing is
   * written on a refusal.
   */
  split(
    tx: SqlDriver,
    item: ItemId,
    rows: readonly { kind: "fact" | "relation"; id: number }[],
    name: string,
    at?: string,
  ): SplitResult;
  /** Sets or clears the distinct mark of a pair (R16); setting it also drops the pair's candidate. */
  setDistinct(tx: SqlDriver, a: ItemId, b: ItemId, on: boolean, at?: string): DistinctResult;
}

export interface EntityDecisionsOptions {
  /** Whether the policy lets these source versions be put together (false on any doubt, I04-R14). */
  combinable(db: SqlDriver, lineage: readonly SourceVersionRef[]): boolean;
  /** The fixed list the composition root hands over (R13); empty where nothing rests on a membership yet. */
  listeners: readonly MembershipListener[];
  /** Writes the direct add of an item and its creation line (semantic-user.ts); the split's new item is one. */
  createItem(tx: SqlDriver, type: string, name: string, at: string | undefined): ItemId;
}

const NOW = "coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

const typeOf = (tx: SqlDriver, id: ItemId): string | undefined =>
  tx.all("SELECT type FROM items WHERE id = ?", [id])[0]?.type as string | undefined;

/** One state-neutral history line on an item: the two states are the row's own (R11). */
function writeMergeLine(
  tx: SqlDriver,
  item: ItemId,
  action: "merge" | "unmerge" | "split",
  mergeId: number | null,
  at: string | undefined,
): void {
  const ref = { kind: "item", id: item } as const;
  const row = readRow(tx, ref);
  if (!row) throw new Error(`item ${item} vanished while its merge line was written`);
  writeLine(tx, ref, { from: row, to: row, actor: "user", action, batch: mergeId, at });
}

const ordered = (a: ItemId, b: ItemId): [ItemId, ItemId] => (a < b ? [a, b] : [b, a]);

export function createEntityDecisions(options: EntityDecisionsOptions): EntityDecisions {
  const combinableIn = (tx: SqlDriver) => (lineage: readonly SourceVersionRef[]) =>
    options.combinable(tx, lineage);
  const scopeIn = (tx: SqlDriver): MembershipScope => ({ combinable: combinableIn(tx) });
  return {
    merge(tx, member, into, at) {
      const memberType = typeOf(tx, member);
      const intoType = typeOf(tx, into);
      if (memberType === undefined || intoType === undefined) {
        return { status: "refused", reason: "not-found" };
      }
      if (memberType !== intoType) return { status: "refused", reason: "type-mismatch" };
      const top = rootOf(tx, member);
      const target = rootOf(tx, into);
      if (top === target) return { status: "refused", reason: "already-merged" };
      const joining = componentOf(tx, top);
      const joined = componentOf(tx, target);
      const lineage = unionOfVersions(lineageOfItems(tx, joining), lineageOfItems(tx, joined));
      if (!options.combinable(tx, lineage)) return { status: "refused", reason: "scope-refused" };

      for (const [a, b] of [ordered(member, into), ordered(top, target)]) {
        tx.run("DELETE FROM item_distinct WHERE item_a = ? AND item_b = ?", [a, b]);
      }
      const left = JSON.stringify(joining);
      const right = JSON.stringify(joined);
      tx.run(
        `DELETE FROM merge_candidates
         WHERE (item_a IN (SELECT value FROM json_each(?)) AND item_b IN (SELECT value FROM json_each(?)))
            OR (item_a IN (SELECT value FROM json_each(?)) AND item_b IN (SELECT value FROM json_each(?)))`,
        [left, right, right, left],
      );
      const mergeId = tx.run(
        `INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, ${NOW})`,
        [top, target, at ?? null],
      ).lastInsertRowid;
      writeMergeLine(tx, top, "merge", mergeId, at);
      writeMergeLine(tx, target, "merge", mergeId, at);
      // the whole group was judged together above: every line of it wakes
      const group = componentOf(tx, top);
      for (const line of linesAmong(tx, group)) {
        if (!line.active) tx.run("UPDATE item_merges SET active = 1 WHERE id = ?", [line.id]);
      }
      notifyMembership(tx, options.listeners, { items: group, movedRows: [] }, scopeIn(tx));
      return { status: "applied", mergeId };
    },

    unmerge(tx, mergeId, keepDistinct, at) {
      const line = tx.all("SELECT member_id, representative_id FROM item_merges WHERE id = ?", [
        mergeId,
      ])[0];
      if (!line) return { status: "refused", reason: "not-found" };
      const member = line.member_id as ItemId;
      const representative = line.representative_id as ItemId;
      tx.run("DELETE FROM item_merges WHERE id = ?", [mergeId]);
      writeMergeLine(tx, member, "unmerge", mergeId, at);
      writeMergeLine(tx, representative, "unmerge", mergeId, at);
      if (keepDistinct) {
        const [a, b] = ordered(member, representative);
        tx.run(
          `INSERT OR IGNORE INTO item_distinct (item_a, item_b, by, at) VALUES (?, ?, 'user', ${NOW})`,
          [a, b, at ?? null],
        );
      }
      // the two halves are groups of their own now; each is judged again
      rejudgeGroups(tx, [member, representative], combinableIn(tx));
      const reached = new Set([...componentOf(tx, member), ...componentOf(tx, representative)]);
      notifyMembership(tx, options.listeners, { items: [...reached], movedRows: [] }, scopeIn(tx));
      return { status: "applied", member, representative };
    },

    split(tx, item, rows, name, at) {
      const type = typeOf(tx, item);
      if (type === undefined) return { status: "refused", reason: "not-found" };
      if (rows.length === 0) return { status: "refused", reason: "nothing-selected" };
      const facts = [...new Set(rows.filter((r) => r.kind === "fact").map((r) => r.id))];
      const relations = [...new Set(rows.filter((r) => r.kind === "relation").map((r) => r.id))];
      const own = (sql: string, ids: number[]) =>
        tx.all(`${sql} AND id IN (SELECT value FROM json_each(?))`, [
          ...(sql.includes("subject_id") ? [item, item] : [item]),
          JSON.stringify(ids),
        ]).length;
      if (
        own("SELECT id FROM facts WHERE item_id = ?", facts) !== facts.length ||
        own("SELECT id FROM relations WHERE (subject_id = ? OR object_id = ?)", relations) !==
          relations.length
      ) {
        return { status: "refused", reason: "row-not-on-item" };
      }
      const total =
        (tx.all("SELECT count(*) AS n FROM facts WHERE item_id = ?", [item])[0]?.n as number) +
        (tx.all("SELECT count(*) AS n FROM relations WHERE subject_id = ? OR object_id = ?", [
          item,
          item,
        ])[0]?.n as number);
      if (facts.length + relations.length >= total) {
        return { status: "refused", reason: "nothing-left" };
      }
      const created = options.createItem(tx, type, name, at);
      for (const id of facts) {
        tx.run("UPDATE facts SET item_id = ? WHERE id = ?", [created, id]);
        tx.run(
          "INSERT INTO item_split_moves (from_item_id, to_item_id, fact_id) VALUES (?, ?, ?)",
          [item, created, id],
        );
      }
      for (const id of relations) {
        tx.run(
          `UPDATE relations SET subject_id = CASE WHEN subject_id = ? THEN ? ELSE subject_id END,
             object_id = CASE WHEN object_id = ? THEN ? ELSE object_id END WHERE id = ?`,
          [item, created, item, created, id],
        );
        tx.run(
          "INSERT INTO item_split_moves (from_item_id, to_item_id, relation_id) VALUES (?, ?, ?)",
          [item, created, id],
        );
      }
      const [low, high] = ordered(item, created);
      tx.run(
        `INSERT OR IGNORE INTO item_distinct (item_a, item_b, by, at) VALUES (?, ?, 'user', ${NOW})`,
        [low, high, at ?? null],
      );
      writeMergeLine(tx, item, "split", null, at);
      writeMergeLine(tx, created, "split", null, at);
      notifyMembership(
        tx,
        options.listeners,
        {
          items: [item, created],
          movedRows: [
            ...facts.map((id) => ({ kind: "fact" as const, id })),
            ...relations.map((id) => ({ kind: "relation" as const, id })),
          ],
        },
        scopeIn(tx),
      );
      return { status: "applied", created, movedFacts: facts, movedRelations: relations };
    },

    setDistinct(tx, a, b, on, at) {
      if (a === b) return { status: "refused", reason: "same-item" };
      if (typeOf(tx, a) === undefined || typeOf(tx, b) === undefined) {
        return { status: "refused", reason: "not-found" };
      }
      const [low, high] = ordered(a, b);
      if (!on) {
        const removed = tx.run("DELETE FROM item_distinct WHERE item_a = ? AND item_b = ?", [
          low,
          high,
        ]).changes;
        return { status: removed > 0 ? "applied" : "unchanged" };
      }
      const marked = tx.run(
        `INSERT OR IGNORE INTO item_distinct (item_a, item_b, by, at) VALUES (?, ?, 'user', ${NOW})`,
        [low, high, at ?? null],
      ).changes;
      // rejecting a candidate is this: the line goes, the mark stays
      const dropped = tx.run("DELETE FROM merge_candidates WHERE item_a = ? AND item_b = ?", [
        low,
        high,
      ]).changes;
      return { status: marked + dropped > 0 ? "applied" : "unchanged" };
    },
  };
}
