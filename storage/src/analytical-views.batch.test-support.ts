// Test support for ARB-C3 (#233): one fixed world of Datasets, Metrics and Joins that holds every shape the
// analytical reads branch on (a merged group, a user-written fact, a fact with no evidence, a fact with a rival
// value) and one hidden row of each kind `Visibility` judges. `batchWorld` is deterministic: the golden file
// next to the test was made from it by the code before the batching.
import {
  dataset,
  fact,
  item,
  line,
  relation,
  storeVersion,
} from "./analytical-check-lines.test-support.ts";
import type { Visibility } from "./analytical-views.ts";
import { addEvidence } from "./knowledge.ts";
import { userDecisions } from "./semantic-user.ts";
import type { SqlDriver } from "./sql-driver.ts";

export interface BatchWorld {
  /** `kind:id` of every row the caller may not see. */
  hidden: Set<string>;
  /** The ids behind the hidden rows, by what they are. */
  ids: { item: number; fact: number; evidence: number; relation: number };
  vis: Visibility;
}

export function batchWorld(db: SqlDriver): BatchWorld {
  const cite = (factId: number, versionId: number) =>
    addEvidence(db, {
      target: { factId },
      sourceVersionId: versionId,
      start: 0,
      end: 1,
      quote: "a",
    });
  const at = "2026-11-23T00:00:00.000Z";
  const table = storeVersion(db, "orders");
  const orders = dataset(db, "orders", table.sourceId);
  for (const column of ["id", "amount"])
    cite(fact(db, orders, "dataset.column", column), table.versionId);
  const grain = fact(db, orders, "dataset.grain", '["id"]');
  cite(grain, table.versionId);
  line(db, grain, "grain", table.versionId);
  const doc = item(db, "Dataset", "orders-doc");
  db.transaction(() => userDecisions.entities.merge(db, orders, doc, at));

  const metric = item(db, "Metric", "매출");
  relation(db, metric, "MEASURED_ON", orders);
  const calc = fact(db, metric, "metric.calculation", '{"aggregation":"sum","column":"amount"}');
  cite(calc, table.versionId);
  line(db, calc, "schema", table.versionId);
  line(db, calc, "aggregation", table.versionId);
  cite(fact(db, metric, "metric.unit", "won"), table.versionId);
  cite(fact(db, metric, "metric.unit", "usd"), table.versionId);
  fact(db, metric, "definition", "월 매출 합계");
  userDecisions.add(
    db,
    { kind: "fact", itemId: metric, factKind: "alias.synonym", value: "revenue" },
    at,
  );
  const hiddenFact = fact(db, metric, "metric.period", "month");
  cite(hiddenFact, table.versionId);
  const hiddenEvidence = cite(fact(db, metric, "metric.version", "v1"), table.versionId);
  const hiddenLine = db.all("SELECT id FROM analytical_checks WHERE check_name = 'aggregation'")[0]
    ?.id as number;

  const secret = item(db, "Metric", "secret");
  cite(fact(db, secret, "metric.unit", "won"), table.versionId);

  const join = item(db, "Join", "orders-self");
  const left = relation(db, join, "JOIN_LEFT", orders);
  relation(db, join, "JOIN_RIGHT", orders);
  relation(db, metric, "USES_JOIN", join);
  const keys = fact(db, join, "join.keys", '[["id","id"]]');
  cite(keys, table.versionId);
  line(db, keys, "schema", table.versionId);

  const hidden = new Set([
    `item:${secret}`,
    `fact:${hiddenFact}`,
    `evidence:${hiddenEvidence}`,
    `relation:${left}`,
    `analytical-check:check:${hiddenLine}`,
  ]);
  return {
    hidden,
    ids: { item: secret, fact: hiddenFact, evidence: hiddenEvidence, relation: left },
    vis: { shown: (kind, id) => !hidden.has(`${kind}:${id}`) },
  };
}
