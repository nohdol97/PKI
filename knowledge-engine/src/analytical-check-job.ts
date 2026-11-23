// The `analytical-check` job (S03-R12): for one table source it re-checks every check-needing fact of the
// source's Datasets and of the Metrics and Joins that reach them through `MEASURED_ON`, `JOIN_LEFT`,
// `JOIN_RIGHT` and `USES_JOIN` (two written paths, no recursion), and writes one line per (fact, check)
// through `commitDerived`. The version of the source is the job's fence. The tables are read outside the
// transaction (the table port is not read inside one); a knowledge change between the read and the write
// discards the result and queues the job again (provisional decision D5). No Provider is called: the handler
// has no Broker. A check whose input cannot be fixed to one row is not computed and writes no line; a stored
// value the pure functions would misjudge (an aggregation with no column, an empty or unreadable column list)
// fails with `column-missing` and never passes (D4). The closing transaction then judges (S03-R15, R16): a
// `verified` fact with a current failing line, or one a split left without its table, loses its standing, and
// the facts the job reached are assessed for the automatic promotion again. That item is bookkeeping, not source
// content: it is handed fact ids only and reads stored pass/fail flags and row states, so the scope policy is not
// asked (a refused lineage must not leave a `verified` row over a failing line).
import {
  BOOKKEEPING_KIND,
  findSourceVersionId,
  isFenceCurrent,
  judgeCheckJob,
  listOntologyElements,
  normalizeValue,
  readAnalyticalMaxCells,
  readKnowledgeRevision,
  registerAnalyticalCheckJob,
  rowLineage,
  saveCheckLine,
  splitMovedClaims,
  unionOfVersions,
  type DerivedItem,
  type SourceVersionRef,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { assessAfterChecks } from "./auto-verify.ts";
import {
  checkAggregation,
  checkGrain,
  checkJoinCardinality,
  checkSchema,
  type Aggregation,
  type CheckResult,
  type DataCheck,
  type JoinCardinality,
  type JoinUse,
} from "./analytical-checks.ts";
import { DATASET_TABLE_ITEM_KIND } from "./dataset-profile.ts";
import {
  sqlTabularSource,
  type TableRead,
  type TabularRead,
  type TabularSource,
} from "./tabular-source.ts";

/** What the handler hands the runner (a subset of backend job-outcomes.ts JobResult). */
export type AnalyticalCheckResult =
  | { status: "succeeded"; items: readonly DerivedItem[] }
  | { status: "superseded" }
  | { status: "fail"; code: string; retryable: false };

export interface AnalyticalCheckOptions {
  db: SqlDriver;
  /** The port the tables are read through; default the one that reads the stored version. */
  source?: TabularSource;
  now?: () => Date;
}

const LIVE = "status NOT IN ('superseded', 'rejected')";
const CHECKED_TYPES = ["Dataset", "Metric", "Join"];

interface Rule {
  valueType: string;
  dataChecks: readonly DataCheck[];
}
interface FactRow {
  id: number;
  itemId: number;
  itemType: string;
  kind: string;
  value: string;
}
interface Touched {
  ref: SourceVersionRef;
  versionId: number;
}
interface Computed {
  result: CheckResult;
  /** The table versions read, the first being the fact's own table. */
  touched: Map<string, Touched>;
}

const failed = (check: DataCheck): CheckResult => ({
  check,
  passed: false,
  failure: "column-missing",
  examined: 0,
  violations: 0,
  skipped: 0,
});
const keyOf = (ref: SourceVersionRef) => `${ref.sourceId}@${ref.version}`;

export function createAnalyticalCheckHandler(options: AnalyticalCheckOptions) {
  const { db } = options;
  const tabular = options.source ?? sqlTabularSource;
  const now = options.now ?? (() => new Date());

  return async (job: StoredJob): Promise<AnalyticalCheckResult> => {
    const { sourceId, fenceVersion } = job; // a check job has both (schema v10 CHECK)
    if (
      sourceId === null ||
      fenceVersion === null ||
      findSourceVersionId(db, sourceId, fenceVersion) === undefined
    ) {
      return { status: "fail", code: "missing-version", retryable: false };
    }
    if (!isFenceCurrent(db, { sourceId, fenceVersion })) return { status: "superseded" };
    const own: SourceVersionRef = { sourceId, version: fenceVersion };
    const revision = readKnowledgeRevision(db);
    const maxCells = readAnalyticalMaxCells(db);

    // ---- reads ------------------------------------------------------------------------------------------
    const rules = new Map<string, Rule>();
    for (const e of listOntologyElements(db)) {
      if (e.status !== "verified" || e.rule.elementKind !== "fact-kind") continue;
      rules.set(e.name, {
        valueType: e.rule.valueType,
        dataChecks: (e.rule.dataChecks ?? []) as readonly DataCheck[],
      });
    }
    const ids = (sql: string, params: unknown[]): number[] =>
      db.all(sql, params as never).map((r) => Object.values(r)[0] as number);
    const json = (list: readonly number[]) => JSON.stringify(list);
    const objects = (itemId: number, type: string): number[] =>
      ids(
        `SELECT object_id FROM relations WHERE subject_id = ? AND type = ? AND ${LIVE} ORDER BY object_id`,
        [itemId, type],
      );
    const subjects = (objectIds: readonly number[], types: readonly string[]): number[] =>
      ids(
        `SELECT DISTINCT subject_id FROM relations
          WHERE type IN (${types.map((t) => `'${t}'`).join(", ")}) AND ${LIVE}
            AND object_id IN (SELECT value FROM json_each(?)) ORDER BY subject_id`,
        [json(objectIds)],
      );
    const factsOn = (itemIds: readonly number[]): FactRow[] =>
      db
        .all(
          `SELECT f.id, f.item_id, i.type, f.kind, f.value FROM facts f JOIN items i ON i.id = f.item_id
            WHERE f.item_id IN (SELECT value FROM json_each(?)) AND f.${LIVE} ORDER BY f.id`,
          [json(itemIds)],
        )
        .map((r) => ({
          id: r.id as number,
          itemId: r.item_id as number,
          itemType: r.type as string,
          kind: r.kind as string,
          value: r.value as string,
        }));
    /** Every check-needing fact of the reach, whatever its state (the judgement filters by state). */
    const datasets = ids(
      "SELECT item_id FROM dataset_tables WHERE source_id = ? ORDER BY item_id",
      [sourceId],
    );
    const metrics = subjects(datasets, ["MEASURED_ON"]);
    const joins = subjects(datasets, ["JOIN_LEFT", "JOIN_RIGHT"]);
    const reachItems = [
      ...new Set([...datasets, ...metrics, ...joins, ...subjects(joins, ["USES_JOIN"])]),
    ];
    const reach = db
      .all(
        `SELECT f.id, f.item_id, i.type, f.kind, f.value FROM facts f JOIN items i ON i.id = f.item_id
          WHERE f.item_id IN (SELECT value FROM json_each(?)) ORDER BY f.id`,
        [json(reachItems)],
      )
      .map((r): FactRow => ({
        id: r.id as number,
        itemId: r.item_id as number,
        itemType: r.type as string,
        kind: r.kind as string,
        value: r.value as string,
      }))
      .filter(
        (f) =>
          CHECKED_TYPES.includes(f.itemType) && (rules.get(f.kind)?.dataChecks.length ?? 0) > 0,
      );

    // ---- tables -----------------------------------------------------------------------------------------
    const reads = new Map<number, { read: TabularRead; touched: Touched } | null>();
    const currentRead = (source: number) => {
      if (reads.has(source)) return reads.get(source) ?? null;
      const version = db.all(
        `SELECT v.version, v.id FROM source_versions v
          WHERE v.source_id = ? AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.source_id = v.source_id AND t.covers_version >= v.version)
          ORDER BY v.version DESC LIMIT 1`,
        [source],
      )[0];
      const ref = version ? { sourceId: source, version: version.version as number } : undefined;
      const read = ref ? tabular.read(db, ref, { maxCells }) : null;
      const found =
        ref && read ? { read, touched: { ref, versionId: version?.id as number } } : null;
      reads.set(source, found);
      return found;
    };

    const compute = (() => {
      const memo = new Map<string, Computed | undefined>();
      const run = (fact: FactRow, check: DataCheck): Computed | undefined => {
        const touched = new Map<string, Touched>();
        const tableOf = (itemId: number | undefined): TableRead | undefined => {
          if (itemId === undefined) return undefined;
          const row = db.all(
            "SELECT source_id, table_key FROM dataset_tables WHERE item_id = ? ORDER BY id LIMIT 1",
            [itemId],
          )[0];
          if (!row) return undefined;
          const found = currentRead(row.source_id as number);
          if (!found) return undefined;
          const entry = found.read.tables.find((t) => t.key === row.table_key);
          if (entry) touched.set(keyOf(found.touched.ref), found.touched);
          return entry;
        };
        const done = (result: CheckResult): Computed => ({ result, touched });
        const bad = () => done(failed(check));
        const rule = (f: FactRow) => rules.get(f.kind);
        const ofRole = (itemId: number, role: (r: Rule) => boolean) =>
          factsOn([itemId]).filter((f) => {
            const r = rule(f);
            return r !== undefined && role(r);
          });
        const parsed = <T>(f: FactRow, valueType: string): T | null => {
          const text = normalizeValue(valueType as never, f.value);
          if (text === null) return null;
          return valueType === "column" ||
            valueType === "header" ||
            valueType === "join-cardinality"
            ? (text as T)
            : (JSON.parse(text) as T);
        };
        const valueType = rules.get(fact.kind)?.valueType ?? "";
        const merge = (inputs: Computed | undefined) => {
          if (inputs) for (const [k, v] of inputs.touched) if (!touched.has(k)) touched.set(k, v);
        };

        if (check === "schema") {
          if (valueType === "key-pairs") {
            const pairs = parsed<[string, string][]>(fact, "key-pairs");
            const left = objects(fact.itemId, "JOIN_LEFT");
            const right = objects(fact.itemId, "JOIN_RIGHT");
            if (left.length > 1 || right.length > 1) return undefined; // D10: no table to choose
            if (pairs === null) return bad();
            const a = checkSchema(
              tableOf(left[0]),
              pairs.map((p) => p[0]),
            );
            const b = checkSchema(
              tableOf(right[0]),
              pairs.map((p) => p[1]),
            );
            const hard = [a, b].find((r) => r.failure === "no-table" || r.failure === "too-large");
            if (hard) return done(hard);
            const missing = a.violations + b.violations;
            return done({
              check,
              passed: missing === 0,
              failure: missing > 0 ? "column-missing" : null,
              examined: a.examined + b.examined,
              violations: missing,
              skipped: 0,
            });
          }
          let columns: string[] | null;
          if (valueType === "column-set") columns = parsed<string[]>(fact, "column-set");
          else if (valueType === "calculation") {
            const c = parsed<{ aggregation: string; column?: string }>(fact, "calculation");
            columns = c === null ? null : c.column === undefined ? [] : [c.column];
          } else {
            const one = parsed<string>(fact, "column");
            columns = one === null ? null : [one];
          }
          if (columns === null) return bad();
          let dataset: number | undefined = fact.itemId;
          if (fact.itemType === "Metric") {
            const on = objects(fact.itemId, "MEASURED_ON");
            if (on.length > 1) return undefined;
            dataset = on[0];
          }
          return done(checkSchema(tableOf(dataset), columns));
        }

        if (check === "grain") {
          const columns = parsed<string[]>(fact, "column-set");
          if (columns === null) return bad();
          return done(checkGrain(tableOf(fact.itemId), columns));
        }

        if (check === "join-cardinality") {
          const claim = parsed<JoinCardinality>(fact, "join-cardinality");
          const keyFacts = ofRole(fact.itemId, (r) => r.valueType === "key-pairs");
          const left = objects(fact.itemId, "JOIN_LEFT");
          const right = objects(fact.itemId, "JOIN_RIGHT");
          if (keyFacts.length > 1 || left.length > 1 || right.length > 1) return undefined;
          const pairs = keyFacts[0] ? parsed<[string, string][]>(keyFacts[0], "key-pairs") : [];
          if (claim === null || pairs === null) return bad();
          const l = tableOf(left[0]);
          const r = tableOf(right[0]);
          return done(checkJoinCardinality(l, r, pairs as [string, string][], claim));
        }

        // aggregation
        const calc = parsed<{ aggregation: Aggregation; column?: string }>(fact, "calculation");
        const measured = objects(fact.itemId, "MEASURED_ON");
        if (measured.length > 1) return undefined;
        const dataset = measured[0];
        const table = tableOf(dataset);
        const grains =
          dataset === undefined ? [] : ofRole(dataset, (r) => r.dataChecks.includes("grain"));
        if (grains.length > 1) return undefined;
        const used: JoinUse[] = [];
        for (const join of objects(fact.itemId, "USES_JOIN")) {
          const keyFacts = ofRole(join, (r) => r.valueType === "key-pairs");
          const cardinalities = ofRole(join, (r) => r.valueType === "join-cardinality");
          const left = objects(join, "JOIN_LEFT");
          const right = objects(join, "JOIN_RIGHT");
          if (
            keyFacts.length > 1 ||
            cardinalities.length > 1 ||
            left.length > 1 ||
            right.length > 1
          ) {
            return undefined;
          }
          const sides = [left[0], right[0]];
          const isLeft = dataset !== undefined && left[0] === dataset;
          const isSide = dataset !== undefined && sides.includes(dataset);
          const pairs = keyFacts[0] ? parsed<[string, string][]>(keyFacts[0], "key-pairs") : [];
          const cardinality = cardinalities[0]
            ? compute_(cardinalities[0], "join-cardinality")
            : undefined;
          merge(cardinality);
          const opposite = tableOf(isLeft ? right[0] : left[0]);
          used.push({
            passed: cardinalities.length === 1 && cardinality?.result.passed === true,
            datasetIsSide: isSide,
            opposite,
            oppositeKeyColumns: (pairs ?? []).map((p) => (isLeft ? p[1] : p[0])),
          });
        }
        if (calc === null) return bad();
        const grain = grains[0] ? compute_(grains[0], "grain") : undefined;
        merge(grain);
        return done(
          checkAggregation({
            table,
            aggregation: calc.aggregation,
            column: calc.column,
            grainPassed: grains.length === 1 && grain?.result.passed === true,
            joins: used,
          }),
        );
      };
      const compute_ = (fact: FactRow, check: DataCheck): Computed | undefined => {
        const key = `${fact.id}:${check}`;
        if (!memo.has(key)) memo.set(key, run(fact, check));
        return memo.get(key);
      };
      return compute_;
    })();

    // ---- the result -------------------------------------------------------------------------------------
    const outcomes: { fact: FactRow; computed: Computed }[] = [];
    for (const fact of reach) {
      for (const check of rules.get(fact.kind)?.dataChecks ?? []) {
        const computed = compute(fact, check);
        if (computed) outcomes.push({ fact, computed });
      }
    }
    const ownVersionId = findSourceVersionId(db, own.sourceId, own.version) as number;
    let stale = false;

    // bookkeeping, not source content (it compares a number, deletes rows, queues a job): the scope policy is
    // not asked, so a refused lineage can neither hide a change nor skip the erase (#182)
    const sweep: DerivedItem = {
      kind: BOOKKEEPING_KIND,
      unjudged: true as const,
      itemKey: JSON.stringify(["check-sweep", sourceId]),
      lineage: [own],
      write: (tx) => {
        if (readKnowledgeRevision(tx) !== revision) {
          // a row changed after the tables were read: that change erased its lines, and writing the result
          // computed before would put a stale pass back (D5)
          stale = true;
          registerAnalyticalCheckJob(tx, own.sourceId, now());
          return;
        }
        tx.run("DELETE FROM analytical_checks WHERE fact_id IN (SELECT value FROM json_each(?))", [
          json(reach.map((f) => f.id)),
        ]);
      },
    };
    const lineItems: DerivedItem[] = outcomes.map(({ fact, computed }) => {
      const { result, touched } = computed;
      const read = [...touched.values()];
      const [primary, ...others] = read;
      const distinct = others.filter((t) => t.versionId !== primary?.versionId);
      return {
        kind: DATASET_TABLE_ITEM_KIND,
        itemKey: JSON.stringify(["check", fact.id, result.check]),
        lineage: unionOfVersions(
          read.map((t) => t.ref),
          rowLineage(db, { kind: "fact", id: fact.id }),
        ),
        write: (tx) => {
          if (stale) return;
          saveCheckLine(tx, {
            factId: fact.id,
            check: result.check,
            passed: result.passed,
            failure: result.failure,
            examined: result.examined,
            violations: result.violations,
            skipped: result.skipped,
            versionId: primary?.versionId ?? ownVersionId,
            otherVersionId: distinct.length === 1 ? (distinct[0]?.versionId ?? null) : null,
            at: now().toISOString(),
          });
        },
      };
    });
    // the judgement of the lines just written, in the same transaction (S03-R15, R16); bookkeeping like the sweep
    const judgement: DerivedItem = {
      kind: BOOKKEEPING_KIND,
      unjudged: true as const,
      itemKey: JSON.stringify(["check-judge", sourceId]),
      lineage: [own],
      write: (tx) => {
        if (stale) return;
        const at = now();
        const reached = reach.map((f) => f.id);
        judgeCheckJob(tx, {
          source: own,
          facts: reached,
          splitMoved: splitMovedClaims(tx, own.sourceId),
          at,
        });
        assessAfterChecks(tx, reached, at.toISOString());
      },
    };
    return { status: "succeeded", items: [sweep, ...lineItems, judgement] };
  };
}
