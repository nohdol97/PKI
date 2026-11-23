// Plain reads the retrieval module (X01-T1) needs and no other read gives: a source version's place in its
// source and the origin system's own time (the version's `meta`, written by the arrival path), which source
// versions a fact, relation or item rests on, and the facts that carry a time. Reads only; the read gate is the
// caller's (a row is shown only through the registry's `visible`).
import type { KnowledgeStatus } from "./knowledge.ts";
import type { SqlDriver } from "./sql-driver.ts";

const IDS = "(SELECT value FROM json_each(?))";

export interface VersionHead {
  id: number;
  sourceId: number;
  version: number;
  connectorId: string;
  /** The row ids of the later versions of the same source (empty when this is its latest). */
  newerIds: number[];
  /** The origin system's update time, else its creation time, as the record gave it; null when the version carries none. */
  originAt: string | null;
}

/** The heads of these source version rows (ids not stored are absent), in the order asked. */
export function readVersionHeads(db: SqlDriver, ids: readonly number[]): VersionHead[] {
  if (ids.length === 0) return [];
  const rows = db.all(
    `SELECT v.id, v.source_id, v.version, s.connector_instance_id AS connector,
            (SELECT json_group_array(id) FROM source_versions WHERE source_id = v.source_id AND id > v.id) AS newer,
            coalesce(json_extract(v.meta, '$.updatedAt'), json_extract(v.meta, '$.createdAt')) AS origin_at
       FROM source_versions v JOIN sources s ON s.id = v.source_id
      WHERE v.id IN ${IDS}`,
    [JSON.stringify(ids)],
  );
  const byId = new Map(
    rows.map((r) => [
      r.id as number,
      {
        id: r.id as number,
        sourceId: r.source_id as number,
        version: r.version as number,
        connectorId: r.connector as string,
        newerIds: JSON.parse(r.newer as string) as number[],
        originAt: typeof r.origin_at === "string" ? r.origin_at : null,
      },
    ]),
  );
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** The facts whose evidence is in one of these source versions, with the fact's status. */
export function factsEvidencedBy(
  db: SqlDriver,
  versionIds: readonly number[],
): { versionId: number; factId: number; status: KnowledgeStatus }[] {
  if (versionIds.length === 0) return [];
  return db
    .all(
      `SELECT DISTINCT e.source_version_id AS v, f.id AS fact, f.status
         FROM evidence e JOIN facts f ON f.id = e.fact_id
        WHERE e.source_version_id IN ${IDS} ORDER BY e.source_version_id, f.id`,
      [JSON.stringify(versionIds)],
    )
    .map((r) => ({
      versionId: r.v as number,
      factId: r.fact as number,
      status: r.status as KnowledgeStatus,
    }));
}

/**
 * The items a source version supports: the owner of a fact and either end of a relation whose evidence is in it.
 * Each row names the one fact or relation it went through (the other id is null), so a caller can judge it.
 */
export function itemsEvidencedBy(
  db: SqlDriver,
  versionIds: readonly number[],
): { versionId: number; itemId: number; factId: number | null; relationId: number | null }[] {
  if (versionIds.length === 0) return [];
  return db
    .all(
      `SELECT v, item, fact, relation FROM (
         SELECT e.source_version_id AS v, f.item_id AS item, f.id AS fact, NULL AS relation FROM evidence e
           JOIN facts f ON f.id = e.fact_id WHERE e.source_version_id IN ${IDS}
         UNION SELECT e.source_version_id, r.subject_id, NULL, r.id FROM evidence e
           JOIN relations r ON r.id = e.relation_id WHERE e.source_version_id IN ${IDS}
         UNION SELECT e.source_version_id, r.object_id, NULL, r.id FROM evidence e
           JOIN relations r ON r.id = e.relation_id WHERE e.source_version_id IN ${IDS}
       ) ORDER BY v, item, fact, relation`,
      [JSON.stringify(versionIds), JSON.stringify(versionIds), JSON.stringify(versionIds)],
    )
    .map((r) => ({
      versionId: r.v as number,
      itemId: r.item as number,
      factId: r.fact as number | null,
      relationId: r.relation as number | null,
    }));
}

/**
 * The facts that carry a time (a start or an end of their valid interval), newest start first, at most `limit`;
 * `itemIds` narrows to the facts of those items.
 */
export function listDatedFacts(
  db: SqlDriver,
  itemIds: readonly number[] | undefined,
  limit: number,
): {
  id: number;
  itemId: number;
  validAt: string | null;
  validUntil: string | null;
  status: KnowledgeStatus;
}[] {
  return db
    .all(
      `SELECT id, item_id, valid_at, valid_until, status FROM facts
        WHERE (valid_at IS NOT NULL OR valid_until IS NOT NULL)
          ${itemIds === undefined ? "" : `AND item_id IN ${IDS}`}
        ORDER BY coalesce(valid_at, valid_until) DESC, id DESC LIMIT ?`,
      itemIds === undefined ? [limit] : [JSON.stringify(itemIds), limit],
    )
    .map((r) => ({
      id: r.id as number,
      itemId: r.item_id as number,
      validAt: r.valid_at as string | null,
      validUntil: r.valid_until as string | null,
      status: r.status as KnowledgeStatus,
    }));
}
