// A source's purge, storage part (V02-R12, "T02가 넘기는 것" 5). Deleting a
// version cascades to its evidence and its Insights' evidence links, after which
// nothing tells what it had supported. So the facts and relations the source's
// evidence reached, and the items holding them, are collected first; after the
// delete only those are judged: a collected fact or relation left without evidence
// is deleted whatever its status, then a collected item left without facts and
// relations (its Insights go with it, a foreign key cascade). A collected one that
// stays with past evidence only (another source moved on) becomes superseded, as
// a new version's propagation would make it (rejected and superseded rows stay). Rows never reached
// stay even without evidence. The keyword index rows leave through the version
// delete trigger. The tombstone and the rule's recompute are the caller's, in the
// same transaction (knowledge-engine deletion.ts).
import { CURRENT, setKnowledgeStatus } from "./knowledge.ts";
import type { SqlDriver } from "./sql-driver.ts";

export interface PurgeResult {
  /** Version rows deleted. */
  versions: number;
  /** Deleted ids, ascending. */
  facts: number[];
  relations: number[];
  items: number[];
  /** Kept ids that lost their last current evidence and became superseded, ascending. */
  superseded: { facts: number[]; relations: number[] };
  /** Collected items still stored, ascending: the rule recomputes their pairs. */
  remainingItemIds: number[];
}

const ascending = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);

export function purgeSourceContent(db: SqlDriver, sourceId: number): PurgeResult {
  return db.transaction(() => {
    const cited = (column: "fact_id" | "relation_id") =>
      `SELECT e.${column} FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
       WHERE v.source_id = ? AND e.${column} IS NOT NULL`;
    const facts = db.all(`SELECT id, item_id FROM facts WHERE id IN (${cited("fact_id")})`, [
      sourceId,
    ]);
    const relations = db.all(
      `SELECT id, subject_id, object_id FROM relations WHERE id IN (${cited("relation_id")})`,
      [sourceId],
    );
    const collected = ascending([
      ...facts.map((f) => f.item_id as number),
      ...relations.flatMap((r) => [r.subject_id as number, r.object_id as number]),
    ]);

    const { changes: versions } = db.run("DELETE FROM source_versions WHERE source_id = ?", [
      sourceId,
    ]);

    const unsupported = (table: "facts" | "relations", column: string, rows: typeof facts) => {
      const gone = rows
        .map((r) => r.id as number)
        .filter(
          (id) => db.all(`SELECT 1 FROM evidence WHERE ${column} = ? LIMIT 1`, [id]).length === 0,
        );
      for (const id of gone) db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
      return gone;
    };
    const deletedFacts = unsupported("facts", "fact_id", facts);
    const deletedRelations = unsupported("relations", "relation_id", relations);
    const supersede = (kind: "fact" | "relation", rows: typeof facts, deleted: number[]) => {
      const table = kind === "fact" ? "facts" : "relations";
      const stale = rows
        .map((r) => r.id as number)
        .filter((id) => !deleted.includes(id))
        .filter(
          (id) =>
            db.all(
              `SELECT 1 FROM ${table} t
               WHERE t.id = ? AND t.status NOT IN ('superseded', 'rejected')
                 AND NOT EXISTS (SELECT 1 FROM evidence e
                                 JOIN source_versions v ON v.id = e.source_version_id
                                 WHERE e.${kind}_id = t.id AND ${CURRENT})`,
              [id],
            ).length === 1,
        );
      for (const id of stale) setKnowledgeStatus(db, kind, id, "superseded");
      return ascending(stale);
    };
    const superseded = {
      facts: supersede("fact", facts, deletedFacts),
      relations: supersede("relation", relations, deletedRelations),
    };

    const items: number[] = [];
    const remainingItemIds: number[] = [];
    for (const id of collected) {
      const held = db.all(
        `SELECT 1 FROM facts WHERE item_id = ?
         UNION ALL SELECT 1 FROM relations WHERE subject_id = ? OR object_id = ? LIMIT 1`,
        [id, id, id],
      );
      if (held.length > 0) remainingItemIds.push(id);
      else {
        db.run("DELETE FROM items WHERE id = ?", [id]);
        items.push(id);
      }
    }
    return {
      versions,
      facts: ascending(deletedFacts),
      relations: ascending(deletedRelations),
      items,
      superseded,
      remainingItemIds,
    };
  });
}
