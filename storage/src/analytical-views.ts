// The analytical reads (S03-R8, R9, R19): `listMetricViews` (the one function behind the API's Metric list and
// K01's `metrics` page) and `listAnalytical` (Datasets, Metrics and Joins for `GET /api/analytical`). Reads only,
// and no value is computed: a column name or a calculation as the row states it, the codes and counts of a check
// line, ids (S03-R18). What the caller may not see is judged by `Visibility`, the read gate's `visible` as a
// predicate, so a row it hides, a check line it hides and a table it hides are absent whole, as is anything that
// would name them (a count, an id in a conflict list). Storage never imports the registry.
import { limitationCodes } from "@pki/contracts";
import { otherValidValues } from "./assertion-links.ts";
import { dataChecksUnmet, needsDataChecks, type DataCheckUnmet } from "./analytical-gate.ts";
import { listCheckLines, waitingRelations, type CheckName } from "./analytical-check-lines.ts";
import { entityGroups } from "./entity-groups.ts";
import { listEvidence, type EpistemicType, type KnowledgeStatus } from "./knowledge.ts";
import { isUserDecided } from "./semantic-lifecycle.ts";
import {
  listSemanticFacts,
  listSemanticRelations,
  type SemanticFactView,
  type SemanticRelationView,
} from "./semantic-view.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { isValidRow } from "./valid-row.ts";

/** Whether a derived row is shown: `kind` is the registry's (`item`, `fact`, `relation`, `evidence`, `source`, `analytical-check`). */
export interface Visibility {
  shown(kind: string, id: string): boolean;
}
export const SHOW_ALL: Visibility = { shown: () => true };

export interface CheckResultView {
  check: CheckName;
  passed: boolean;
  failure: string | null;
  examined: number;
  violations: number;
  skipped: number;
}
export interface FactRowView extends Omit<SemanticFactView, "evidenceCount"> {
  /** The current evidence the caller may see (ids; the count is its length). */
  evidenceIds: number[];
  evidenceCount: number;
  /** Whether the kind's rule names `dataChecks`; `checks` and `unmet` are empty for a kind that does not. */
  checkNeeded: boolean;
  /** The current lines only: a line that is not current is as good as absent (S03-R11). */
  checks: CheckResultView[];
  unmet: DataCheckUnmet[];
  /** The sources whose extraction this row waits on (S03-R16); empty when it does not wait. */
  awaitingSourceIds: number[];
}
export interface RelationRowView extends Omit<SemanticRelationView, "evidenceCount"> {
  evidenceIds: number[];
  evidenceCount: number;
}
export interface ConflictView {
  /** The fact kind, the relation type, or `multiple-tables` (a group with real tables on several members). */
  kind: string;
  rowKind: "fact" | "relation" | "item";
  ids: number[];
}
export interface TableView {
  tableId: number;
  sourceId: number;
  rowCount: number;
  /** The limitation codes of the table version's source, per workbook (S03-R4). */
  limitations: string[];
}
export interface DatasetRefView {
  itemId: number;
  name: string;
  tables: TableView[];
  /** Another member of the same group has a real table and this item has none (not counted for the gate, R8). */
  groupTableItemIds: number[];
  /** This item is the representative of a group and has no real table while a member has one (S03-R8). */
  representativeLacksTable: boolean;
}
export interface ColumnMatchView {
  column: string | null;
  /** The `dataset.column` fact of the current table, or null with a code in `missing`. */
  factId: number | null;
  missing: "column-missing" | "no-table" | null;
}
interface ItemBase {
  itemId: number;
  name: string;
  status: KnowledgeStatus;
  epistemic: EpistemicType;
  userDecided: boolean;
  userAuthored: boolean;
  conflicts: ConflictView[];
}
interface MetricBody extends ItemBase {
  terms: FactRowView[];
  definitions: FactRowView[];
  calculations: FactRowView[];
  /** True only when a calculation row is `verified` (S03-R19). */
  calculationConfirmed: boolean;
  /** The `MEASURED_ON` Datasets, live; more than one is a conflict (also listed in `conflicts`). */
  datasets: DatasetRefView[];
  columns: ColumnMatchView[];
  grain: FactRowView[];
  joins: { itemId: number; name: string }[];
  units: FactRowView[];
  currencies: FactRowView[];
  periods: FactRowView[];
  versions: FactRowView[];
  relations: RelationRowView[];
}
/** A member of a group: listed under its representative, with no members of its own. */
export interface MetricMemberView extends MetricBody {
  members: never[];
}
export interface MetricView extends MetricBody {
  members: MetricMemberView[];
}
interface DatasetBody extends ItemBase {
  tables: TableView[];
  columns: FactRowView[];
  roles: FactRowView[];
  grain: FactRowView[];
  measures: FactRowView[];
  dimensions: FactRowView[];
  timeDimensions: FactRowView[];
  groupTableItemIds: number[];
  representativeLacksTable: boolean;
}
/** A member of a group: listed under its representative, with no members of its own. */
export interface DatasetMemberView extends DatasetBody {
  members: never[];
}
export interface DatasetView extends DatasetBody {
  members: DatasetMemberView[];
}
interface JoinBody extends ItemBase {
  left: { itemId: number; name: string }[];
  right: { itemId: number; name: string }[];
  keys: FactRowView[];
  cardinality: FactRowView[];
  relations: RelationRowView[];
}
export interface JoinMemberView extends JoinBody {
  members: never[];
}
export interface JoinView extends JoinBody {
  members: JoinMemberView[];
}
export interface AnalyticalList {
  datasets: DatasetView[];
  metrics: MetricView[];
  joins: JoinView[];
  /** A list was cut at `limit` items. */
  truncated: boolean;
}

const LIVE = "status NOT IN ('superseded', 'rejected')";
const DEFAULT_LIMIT = 200;
const ascending = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((a, b) => a - b);

class Reader {
  readonly db: SqlDriver;
  readonly vis: Visibility;
  constructor(db: SqlDriver, vis: Visibility) {
    this.db = db;
    this.vis = vis;
  }

  private readonly seen = new Map<string, boolean>();
  /** One visibility question per (kind, id) for the life of this read. */
  shown = (kind: string, id: number | string): boolean => {
    const key = `${kind}:${id}`;
    let answer = this.seen.get(key);
    if (answer === undefined) {
      answer = this.vis.shown(kind, String(id));
      this.seen.set(key, answer);
    }
    return answer;
  };

  private readonly memo = new Map<string, unknown>();
  /** A value built once per read. The value is shared by its readers, who only serialise it. */
  private once<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }

  private awaiting?: Map<number, number[]>;
  /** The sources a relation's subject waits on, by item (read once per call). */
  waitingSources(itemId: number): number[] {
    if (!this.awaiting) {
      this.awaiting = new Map();
      const waits = waitingRelations(this.db);
      if (waits.some((w) => this.shown("relation", w.relationId))) {
        const seen = waits.filter((w) => this.shown("relation", w.relationId));
        const bySource = new Map(seen.map((w) => [w.relationId, w.sourceId]));
        const rows = this.db.all(
          `SELECT id, subject_id FROM relations WHERE id IN (SELECT value FROM json_each(?))
             AND type IN ('MEASURED_ON', 'JOIN_LEFT', 'JOIN_RIGHT')`,
          [JSON.stringify(seen.map((w) => w.relationId))],
        );
        for (const r of rows) {
          const subject = r.subject_id as number;
          const source = bySource.get(r.id as number) as number;
          this.awaiting.set(subject, [...(this.awaiting.get(subject) ?? []), source]);
        }
      }
    }
    return ascending(this.awaiting.get(itemId) ?? []).filter((s) => this.shown("source", s));
  }

  evidenceIds(target: { factId: number } | { relationId: number }): number[] {
    return listEvidence(this.db, target)
      .filter((e) => e.current && this.shown("evidence", e.id))
      .map((e) => e.id);
  }

  factRow(f: SemanticFactView): FactRowView {
    const needed = this.once(`needs:${f.kind}`, () => needsDataChecks(this.db, f.kind));
    const ids = this.evidenceIds({ factId: f.id });
    const checks = needed
      ? listCheckLines(this.db, f.id)
          .filter((l) => l.current && this.shown("analytical-check", `check:${l.id}`))
          .map(({ check, passed, failure, examined, violations, skipped }) => ({
            check,
            passed,
            failure,
            examined,
            violations,
            skipped,
          }))
      : [];
    const itemId = this.db.all("SELECT item_id FROM facts WHERE id = ?", [f.id])[0]
      ?.item_id as number;
    return {
      ...f,
      evidenceIds: ids,
      evidenceCount: ids.length,
      checkNeeded: needed,
      checks,
      unmet: needed ? [...dataChecksUnmet(this.db, { kind: "fact", id: f.id }, this.shown)] : [],
      awaitingSourceIds: needed ? this.waitingSources(itemId) : [],
    };
  }

  facts(itemId: number): FactRowView[] {
    return this.once(`facts:${itemId}`, () =>
      listSemanticFacts(this.db, itemId)
        .filter((f) => this.shown("fact", f.id))
        .map((f) => this.factRow(f)),
    );
  }

  relations(itemId: number): RelationRowView[] {
    return listSemanticRelations(this.db, itemId)
      .filter((r) => this.shown("relation", r.id))
      .map((r) => {
        const ids = this.evidenceIds({ relationId: r.id });
        return { ...r, evidenceIds: ids, evidenceCount: ids.length };
      });
  }

  name(itemId: number): string | undefined {
    return this.shown("item", itemId)
      ? (this.db.all("SELECT name FROM items WHERE id = ?", [itemId])[0]?.name as
          string | undefined)
      : undefined;
  }

  /** The Dataset's real tables: a table row whose source has a version no tombstone covers and the caller may see. */
  tables(datasetId: number): TableView[] {
    return this.once(`tables:${datasetId}`, () => this.readTables(datasetId));
  }

  private readTables(datasetId: number): TableView[] {
    return this.db
      .all(
        `SELECT t.id, t.source_id, t.row_count,
                (SELECT v.meta FROM source_versions v WHERE v.source_id = t.source_id
                  ORDER BY v.version DESC LIMIT 1) AS meta
           FROM dataset_tables t WHERE t.item_id = ? AND EXISTS (
             SELECT 1 FROM source_versions v WHERE v.source_id = t.source_id
                AND NOT EXISTS (SELECT 1 FROM tombstones x
                                 WHERE x.source_id = v.source_id AND x.covers_version >= v.version))
          ORDER BY t.id`,
        [datasetId],
      )
      .filter((r) => this.shown("analytical-check", `table:${r.id}`))
      .map((r) => ({
        tableId: r.id as number,
        sourceId: r.source_id as number,
        rowCount: r.row_count as number,
        limitations: limitationCodes(r.meta),
      }));
  }

  /** The group's other members that have a real table (ascending), the caller seeing both. */
  groupTables(itemId: number): number[] {
    return entityGroups
      .membersOf(this.db, itemId)
      .filter((m) => m !== itemId && this.shown("item", m) && this.tables(m).length > 0);
  }

  datasetRef(itemId: number): DatasetRefView | undefined {
    const name = this.name(itemId);
    if (name === undefined) return undefined;
    const tables = this.tables(itemId);
    const others = tables.length === 0 ? this.groupTables(itemId) : [];
    const representative = entityGroups.representativeOf(this.db, itemId) === itemId;
    return {
      itemId,
      name,
      tables,
      groupTableItemIds: others,
      representativeLacksTable: tables.length === 0 && representative && others.length > 0,
    };
  }

  /** The live objects of a relation type from an item (R10's two written paths read these). */
  objects(itemId: number, type: string): number[] {
    return this.db
      .all(
        `SELECT id, object_id FROM relations WHERE subject_id = ? AND type = ? AND ${LIVE} ORDER BY object_id, id`,
        [itemId, type],
      )
      .filter((r) => this.shown("relation", r.id as number))
      .map((r) => r.object_id as number)
      .filter((id, i, all) => all.indexOf(id) === i && this.shown("item", id));
  }

  /** S03-R9: the group-wide conflicts of an item, with the rows the caller may see; fewer than two is none. */
  conflicts(itemId: number, type: string): ConflictView[] {
    const out = new Map<string, ConflictView>();
    const add = (c: ConflictView) => {
      const ids = ascending(c.ids);
      if (ids.length >= 2) out.set(`${c.rowKind}:${c.kind}:${ids.join(",")}`, { ...c, ids });
    };
    for (const f of this.db.all(
      "SELECT id, kind, status FROM facts WHERE item_id = ? ORDER BY id",
      [itemId],
    )) {
      const id = f.id as number;
      if (!isValidRow(this.db, { kind: "fact", id }, f.status as never)) continue;
      const rivals = otherValidValues(this.db, id, "group");
      add({
        kind: f.kind as string,
        rowKind: "fact",
        ids: [id, ...rivals].filter((x) => this.shown("fact", x)),
      });
    }
    const members = entityGroups.membersOf(this.db, itemId);
    for (const relType of ["MEASURED_ON", "JOIN_LEFT", "JOIN_RIGHT"]) {
      const rows = this.db
        .all(
          `SELECT id, object_id FROM relations WHERE subject_id IN (SELECT value FROM json_each(?))
              AND type = ? AND ${LIVE} ORDER BY id`,
          [JSON.stringify(members), relType],
        )
        .filter((r) => this.shown("relation", r.id as number));
      if (new Set(rows.map((r) => r.object_id)).size > 1) {
        add({ kind: relType, rowKind: "relation", ids: rows.map((r) => r.id as number) });
      }
    }
    if (type === "Dataset") {
      add({
        kind: "multiple-tables",
        rowKind: "item",
        ids: members.filter((m) => this.shown("item", m) && this.tables(m).length > 0),
      });
    }
    return [...out.values()];
  }
}

const ofKind = (rows: readonly FactRowView[], ...kinds: string[]) =>
  rows.filter((r) => kinds.includes(r.kind));

function base(r: Reader, id: number, name: string, type: string): ItemBase | undefined {
  const row = r.db.all("SELECT status, epistemic, user_authored FROM items WHERE id = ?", [id])[0];
  if (!row) return undefined;
  return {
    itemId: id,
    name,
    status: row.status as KnowledgeStatus,
    epistemic: row.epistemic as EpistemicType,
    userDecided: isUserDecided(r.db, { kind: "item", id }),
    userAuthored: row.user_authored === 1,
    conflicts: r.conflicts(id, type),
  };
}

/** The column a calculation fact names, as stored (`{"aggregation":…,"column":…}`); null for a row of no column. */
function calculationColumn(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { column?: unknown };
    return typeof parsed.column === "string" ? parsed.column : null;
  } catch {
    return null;
  }
}

/** S03-R8 (4): the `dataset.column` fact of the Dataset's current table whose current evidence sits in it. */
function matchColumn(
  r: Reader,
  dataset: DatasetRefView | undefined,
  column: string,
): ColumnMatchView {
  if (!dataset || dataset.tables.length === 0) {
    return { column, factId: null, missing: "no-table" };
  }
  const found = r.db.all(
    `SELECT f.id FROM facts f WHERE f.item_id = ? AND f.kind = 'dataset.column' AND f.value = ?
        AND f.${LIVE} AND EXISTS (
          SELECT 1 FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
           WHERE e.fact_id = f.id AND v.source_id IN (SELECT value FROM json_each(?))
             AND v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id))
      ORDER BY f.id`,
    [dataset.itemId, column, JSON.stringify(dataset.tables.map((t) => t.sourceId))],
  );
  const id = found.map((x) => x.id as number).find((x) => r.shown("fact", x));
  return id === undefined
    ? { column, factId: null, missing: "column-missing" }
    : { column, factId: id, missing: null };
}

function metricBody(r: Reader, id: number): MetricBody | undefined {
  const name = r.name(id);
  if (name === undefined) return undefined;
  const head = base(r, id, name, "Metric");
  if (!head) return undefined;
  const facts = r.facts(id);
  const datasets = r.objects(id, "MEASURED_ON").flatMap((d) => r.datasetRef(d) ?? []);
  const calculations = ofKind(facts, "metric.calculation");
  const real = datasets.find((d) => d.tables.length > 0) ?? datasets[0];
  const named = new Set(
    calculations.flatMap((c) => {
      const column = calculationColumn(c.value);
      return column === null ? [] : [column];
    }),
  );
  const columns = [...named].map((column) => matchColumn(r, real, column));
  const grain = datasets.flatMap((d) => ofKind(r.facts(d.itemId), "dataset.grain"));
  const joins = r.objects(id, "USES_JOIN").flatMap((j) => {
    const joinName = r.name(j);
    return joinName === undefined ? [] : [{ itemId: j, name: joinName }];
  });
  return {
    ...head,
    terms: facts.filter((f) => f.kind.startsWith("alias.")),
    definitions: ofKind(facts, "definition"),
    calculations,
    calculationConfirmed: calculations.some((c) => c.status === "verified"),
    datasets,
    columns,
    grain,
    joins,
    units: ofKind(facts, "metric.unit"),
    currencies: ofKind(facts, "metric.currency"),
    periods: ofKind(facts, "metric.period"),
    versions: ofKind(facts, "metric.version"),
    relations: r.relations(id),
  };
}

/** The body of an item and, when it is a group's representative, the bodies of the other members under it. */
function withMembers<B>(
  r: Reader,
  id: number,
  body: (r: Reader, id: number) => B | undefined,
): (B & { members: (B & { members: never[] })[] }) | undefined {
  const head = body(r, id);
  if (!head) return undefined;
  // R1 (#227): members go under the representative only; a member standing alone (its representative hidden)
  // has none, so two visible members never list each other.
  const under =
    entityGroups.representativeOf(r.db, id) === id
      ? entityGroups
          .membersOf(r.db, id)
          .filter((m) => m !== id)
          .flatMap((m) => {
            const member = body(r, m);
            return member ? [{ ...member, members: [] as never[] }] : [];
          })
      : [];
  return { ...head, members: under };
}

/**
 * The items of a type the caller sees, at the top level: a member of a group is listed under its representative
 * unless that representative is hidden, then it stands on its own (F4). Visibility is judged before the limit
 * (F3): `truncated` counts visible items only.
 */
function itemIds(r: Reader, type: string, limit: number): { ids: number[]; truncated: boolean } {
  const ids = r.db
    .all("SELECT id FROM items WHERE type = ? ORDER BY id", [type])
    .map((row) => row.id as number)
    .filter((id) => {
      if (!r.shown("item", id)) return false;
      const rep = entityGroups.representativeOf(r.db, id);
      return rep === id || !r.shown("item", rep);
    });
  return { ids: ids.slice(0, limit), truncated: ids.length > limit };
}

/**
 * The Metrics, each answering exactly the fields of S03-R19 and nothing else. The API's Metric list is this
 * result as it is, and K01's `metrics` page calls it too. A Metric the caller may not see is absent, as is every
 * check result it hides. Returns at most `limit` Metrics, in id order; `truncated` is in `listAnalytical`.
 */
export function listMetricViews(
  db: SqlDriver,
  vis: Visibility = SHOW_ALL,
  limit = DEFAULT_LIMIT,
): MetricView[] {
  const r = new Reader(db, vis);
  return itemIds(r, "Metric", limit).ids.flatMap((id) => withMembers(r, id, metricBody) ?? []);
}

function datasetBody(r: Reader, id: number): DatasetBody | undefined {
  const name = r.name(id);
  if (name === undefined) return undefined;
  const head = base(r, id, name, "Dataset");
  if (!head) return undefined;
  const facts = r.facts(id);
  const ref = r.datasetRef(id) as DatasetRefView;
  return {
    ...head,
    tables: ref.tables,
    columns: ofKind(facts, "dataset.column"),
    roles: ofKind(facts, "dataset.role"),
    grain: ofKind(facts, "dataset.grain"),
    measures: ofKind(facts, "dataset.measure"),
    dimensions: ofKind(facts, "dataset.dimension"),
    timeDimensions: ofKind(facts, "dataset.time_dimension"),
    groupTableItemIds: ref.groupTableItemIds,
    representativeLacksTable: ref.representativeLacksTable,
  };
}

function joinBody(r: Reader, id: number): JoinBody | undefined {
  const name = r.name(id);
  if (name === undefined) return undefined;
  const head = base(r, id, name, "Join");
  if (!head) return undefined;
  const facts = r.facts(id);
  const side = (type: string) =>
    r.objects(id, type).flatMap((d) => {
      const n = r.name(d);
      return n === undefined ? [] : [{ itemId: d, name: n }];
    });
  return {
    ...head,
    left: side("JOIN_LEFT"),
    right: side("JOIN_RIGHT"),
    keys: ofKind(facts, "join.keys"),
    cardinality: ofKind(facts, "join.cardinality"),
    relations: r.relations(id),
  };
}

/** The body of `GET /api/analytical` (S03-R19): Datasets (a group under its representative), Metrics, Joins. */
export function listAnalytical(
  db: SqlDriver,
  vis: Visibility = SHOW_ALL,
  limit = DEFAULT_LIMIT,
): AnalyticalList {
  const r = new Reader(db, vis);
  const datasets = itemIds(r, "Dataset", limit);
  const metrics = itemIds(r, "Metric", limit);
  const joins = itemIds(r, "Join", limit);
  return {
    datasets: datasets.ids.flatMap((id) => withMembers(r, id, datasetBody) ?? []),
    metrics: metrics.ids.flatMap((id) => withMembers(r, id, metricBody) ?? []),
    joins: joins.ids.flatMap((id) => withMembers(r, id, joinBody) ?? []),
    truncated: datasets.truncated || metrics.truncated || joins.truncated,
  };
}
