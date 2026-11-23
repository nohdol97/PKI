// Links between two facts (S02-R18, R19): SUPERSEDES (`from` supersedes `to`) and CONTRADICTS (the
// smaller id is `from`). A link changes no row; "who is superseded" is read from the links, and
// `otherValidValues` is the one function that says whether a fact has another valid value in its slot.
import { entityGroups } from "./entity-groups.ts";
import { listOntologyElements } from "./ontology.ts";
import { STATE_NEUTRAL_ACTIONS } from "./semantic-lifecycle.ts";
import type { SqlDriver } from "./sql-driver.ts";
import type { KnowledgeStatus } from "./knowledge.ts";
import { isValidRow } from "./valid-row.ts";

export type LinkType = "SUPERSEDES" | "CONTRADICTS";
export type LinkMaker = "rule" | "propagation" | "user";

/** How far to look: the fact's own item, or every member of its merge group (active merges only). */
export type ConflictReach = "item" | "group";

export interface NewAssertionLink {
  type: LinkType;
  fromFactId: number;
  toFactId: number;
  createdBy: LinkMaker;
  /** The source version the link rests on (a propagation link); both or neither. */
  basis?: { sourceId: number; version: number } | null;
  at: string;
}
export interface StoredAssertionLink extends NewAssertionLink {
  id: number;
  basis: { sourceId: number; version: number } | null;
}

const linkOf = (r: Record<string, unknown>): StoredAssertionLink => ({
  id: r.id as number,
  type: r.type as LinkType,
  fromFactId: r.from_fact_id as number,
  toFactId: r.to_fact_id as number,
  createdBy: r.created_by as LinkMaker,
  basis:
    r.basis_source_id === null
      ? null
      : { sourceId: r.basis_source_id as number, version: r.basis_version as number },
  at: r.at as string,
});

const LINK_COLUMNS =
  "id, type, from_fact_id, to_fact_id, created_by, basis_source_id, basis_version, at";
const IDS = "(SELECT value FROM json_each(?))";

/** Inserts the link unless the same (type, from, to) exists; either way returns its id. */
export function insertAssertionLink(
  db: SqlDriver,
  link: NewAssertionLink,
): { id: number; created: boolean } {
  const { changes } = db.run(
    `INSERT INTO assertion_links (type, from_fact_id, to_fact_id, created_by, basis_source_id, basis_version, at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [
      link.type,
      link.fromFactId,
      link.toFactId,
      link.createdBy,
      link.basis?.sourceId ?? null,
      link.basis?.version ?? null,
      link.at,
    ],
  );
  const id = db.all(
    "SELECT id FROM assertion_links WHERE type = ? AND from_fact_id = ? AND to_fact_id = ?",
    [link.type, link.fromFactId, link.toFactId],
  )[0]?.id as number;
  return { id, created: changes === 1 };
}

export function deleteAssertionLinks(db: SqlDriver, ids: readonly number[]): void {
  if (ids.length === 0) return;
  db.run(`DELETE FROM assertion_links WHERE id IN ${IDS}`, [JSON.stringify(ids)]);
}

/** Every link, oldest first, at most `limit` (all when omitted). */
export function listAssertionLinks(db: SqlDriver, limit?: number): StoredAssertionLink[] {
  return db
    .all(
      `SELECT ${LINK_COLUMNS} FROM assertion_links ORDER BY id${limit === undefined ? "" : " LIMIT ?"}`,
      limit === undefined ? [] : [limit],
    )
    .map(linkOf);
}

/** The links with one of these facts at either end. */
export function linksOfFacts(db: SqlDriver, factIds: readonly number[]): StoredAssertionLink[] {
  if (factIds.length === 0) return [];
  return db
    .all(
      `SELECT ${LINK_COLUMNS} FROM assertion_links
       WHERE from_fact_id IN ${IDS} OR to_fact_id IN ${IDS} ORDER BY id`,
      [JSON.stringify(factIds), JSON.stringify(factIds)],
    )
    .map(linkOf);
}

/**
 * Whether a SUPERSEDES link counts: its superseding (`from`) fact is valid (S01-R15). A propagation link is never
 * removed, so one can outlive the restore of the fact it replaced: a superseder that is itself superseded,
 * rejected or without evidence replaces nothing. The link stays stored; it stops counting. The one test every
 * reader of supersession uses.
 */
export function supersedingStands(
  db: SqlDriver,
  link: Pick<StoredAssertionLink, "id" | "type" | "fromFactId" | "toFactId">,
): boolean {
  if (link.type !== "SUPERSEDES") return false;
  if (!factIsValid(db, link.fromFactId)) return false;
  // a mutual pair with both facts valid: only the later link counts (S02F-R1); the earlier one stays stored
  const reverse = db.all(
    `SELECT 1 FROM assertion_links
     WHERE type = 'SUPERSEDES' AND from_fact_id = ? AND to_fact_id = ? AND id > ? LIMIT 1`,
    [link.toFactId, link.fromFactId, link.id],
  );
  return reverse.length === 0 || !factIsValid(db, link.toFactId);
}

function factIsValid(db: SqlDriver, factId: number): boolean {
  const status = db.all("SELECT status FROM facts WHERE id = ?", [factId])[0]?.status;
  return (
    status !== undefined && isValidRow(db, { kind: "fact", id: factId }, status as KnowledgeStatus)
  );
}

/** Of these facts, the ones that are the superseded end of a counting SUPERSEDES link, with that link's id. */
export function supersededAmong(
  db: SqlDriver,
  factIds: readonly number[],
): { factId: number; linkId: number }[] {
  if (factIds.length === 0) return [];
  return db
    .all(
      `SELECT ${LINK_COLUMNS} FROM assertion_links
       WHERE type = 'SUPERSEDES' AND to_fact_id IN ${IDS} ORDER BY id`,
      [JSON.stringify(factIds)],
    )
    .map(linkOf)
    .filter((l) => supersedingStands(db, l))
    .map((l) => ({ factId: l.toFactId, linkId: l.id }));
}

/** The earliest of the fact's own end and the starts of the facts superseding it; an empty start contributes nothing. */
export function effectiveUntil(
  ownUntil: string | null,
  supersederStarts: readonly (string | null)[],
): string | null {
  const dates = [ownUntil, ...supersederStarts].filter((d): d is string => d !== null);
  return dates.length === 0 ? null : dates.reduce((min, d) => (d < min ? d : min));
}

/** Whether the kind has a `verified` fact-kind definition whose value count is `one`. */
export function oneValueKind(db: SqlDriver, kind: string): boolean {
  const definition = listOntologyElements(db).find(
    (e) => e.elementKind === "fact-kind" && e.name === kind && e.status === "verified",
  );
  return definition?.rule.elementKind === "fact-kind" && definition.rule.cardinality === "one";
}

/**
 * The other valid facts that state a different value in the asked fact's slot (same kind, same
 * context tag), ascending, before any supersession is subtracted. Answers [] for a fact not stored and for
 * a kind with no `verified` fact-kind definition of cardinality `one`. The conflict rule's own input.
 */
export function slotRivals(db: SqlDriver, fact: number, within: ConflictReach): number[] {
  const own = db.all("SELECT item_id, kind, value, context FROM facts WHERE id = ?", [fact])[0];
  if (!own) return [];
  const kind = own.kind as string;
  if (!oneValueKind(db, kind)) return [];
  const items =
    within === "item" ? [own.item_id as number] : entityGroups.membersOf(db, own.item_id as number);
  return db
    .all(
      `SELECT id, status FROM facts
       WHERE item_id IN ${IDS} AND kind = ? AND context IS ? AND value <> ? ORDER BY id`,
      [JSON.stringify(items), kind, own.context as string | null, own.value as string],
    )
    .filter((r) =>
      isValidRow(db, { kind: "fact", id: r.id as number }, r.status as KnowledgeStatus),
    )
    .map((r) => r.id as number);
}

/**
 * The ids (ascending) of the other valid facts that state a different value in the asked fact's slot,
 * without a fact that is the superseded end of any SUPERSEDES link and without a fact that supersedes the
 * asked one. `'item'` for judgements that change state; `'group'` for display. Reads only; visibility is
 * the read gate's.
 */
export function otherValidValues(
  db: SqlDriver,
  fact: number,
  within: ConflictReach,
): readonly number[] {
  const rivals = slotRivals(db, fact, within);
  if (rivals.length === 0) return rivals;
  const superseded = new Set(supersededAmong(db, rivals).map((s) => s.factId));
  const supersedes = new Set(
    linksOfFacts(db, [fact])
      .filter((l) => l.toFactId === fact && supersedingStands(db, l))
      .map((l) => l.fromFactId),
  );
  return rivals.filter((id) => !superseded.has(id) && !supersedes.has(id));
}

/**
 * The facts of the asked fact's slot (same merge group, kind and tag, another value) whose newest state line
 * is the propagation's `supersede` resting on this source version: what the new version replaced (S02-R19's
 * propagation link). Ascending ids; [] for a kind that is not `one`.
 */
export function supersededByVersion(
  db: SqlDriver,
  fact: number,
  basis: { sourceId: number; version: number },
): number[] {
  const own = db.all("SELECT item_id, kind, value, context FROM facts WHERE id = ?", [fact])[0];
  if (!own || !oneValueKind(db, own.kind as string)) return [];
  return db
    .all(
      `SELECT id FROM facts
       WHERE item_id IN ${IDS} AND kind = ? AND context IS ? AND value <> ? AND status = 'superseded' ORDER BY id`,
      [
        JSON.stringify(entityGroups.membersOf(db, own.item_id as number)),
        own.kind as string,
        own.context as string | null,
        own.value as string,
      ],
    )
    .map((r) => r.id as number)
    .filter((id) => {
      const line = db.all(
        `SELECT actor, action, basis_source_id, basis_version FROM fact_history
         WHERE fact_id = ? AND action NOT IN ${IDS} ORDER BY seq DESC LIMIT 1`,
        [id, JSON.stringify([...STATE_NEUTRAL_ACTIONS])],
      )[0];
      return (
        line?.actor === "propagation" &&
        line.action === "supersede" &&
        line.basis_source_id === basis.sourceId &&
        line.basis_version === basis.version
      );
    });
}
