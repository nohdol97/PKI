/* eslint-disable pki/module-boundary -- a measurement script that reaches into the packages' sources on purpose, like the other scripts here (I02B-T03b) */
// S03 decision 35 ⑥ (#227 D2/P3): how long does `GET /api/analytical` take with 200 Datasets, 200 Metrics and 200
// Joins, through the real server, the product's derivative registry and the default scope policy? The world is
// synthetic and deterministic (names `ds-001`...). One warm-up call, then `runs` timed calls; the script asserts
// that each list holds `items` entries and is not truncated, so an empty response cannot be timed.
// Prints one JSON line: { items, runs, samplesMs, medianMs, maxMs, responseBytes, node, platform, cpu }.
// Usage: node analytical-read-latency.ts [items=200] [runs=5]
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { routes } from "../../../packages/contracts/src/index.ts";
import { createProductRegistry } from "../../../knowledge-engine/src/index.ts";
import { send } from "../../../packages/testkit/src/index.ts";
import {
  addEvidence,
  automatedLifecycle,
  createDerivativeRegistry,
  defaultScopePolicy,
  registerConnectorInstance,
  userDecisions,
  type SqlDriver,
} from "../../../storage/src/index.ts";
import {
  openCanonicalDb,
  productAdapters,
  productEgress,
} from "../../../backend/src/composition.ts";
import { startServer } from "../../../backend/src/server.ts";
import {
  dataset,
  fact,
  item,
  line,
  relation,
  storeVersion,
} from "../../../storage/src/analytical-check-lines.test-support.ts";

export interface ReadLatency {
  items: number;
  runs: number;
  samplesMs: number[];
  medianMs: number;
  maxMs: number;
  responseBytes: number;
  node: string;
  platform: string;
  cpu: string;
}

const TOKEN = "l".repeat(43);
const pad = (n: number) => String(n).padStart(3, "0");

/** `items` Datasets, Metrics and Joins, each with evidence and passing current check lines. */
function seed(db: SqlDriver, items: number): void {
  const cite = (factId: number, versionId: number) =>
    addEvidence(db, {
      target: { factId },
      sourceVersionId: versionId,
      start: 0,
      end: 1,
      quote: "a",
    });
  const created = (id: number) =>
    automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  for (let n = 1; n <= items; n++) {
    const table = storeVersion(db, `ds-${pad(n)}`);
    const d = dataset(db, `ds-${pad(n)}`, table.sourceId);
    created(d);
    for (const column of ["id", "day", "amount"])
      cite(fact(db, d, "dataset.column", column), table.versionId);
    const grain = fact(db, d, "dataset.grain", '["id"]');
    cite(grain, table.versionId);
    line(db, grain, "grain", table.versionId);

    const m = item(db, "Metric", `metric-${pad(n)}`);
    created(m);
    relation(db, m, "MEASURED_ON", d);
    const calc = fact(db, m, "metric.calculation", '{"aggregation":"sum","column":"amount"}');
    cite(calc, table.versionId);
    line(db, calc, "schema", table.versionId);
    line(db, calc, "aggregation", table.versionId);
    cite(fact(db, m, "metric.unit", "won"), table.versionId);

    const j = item(db, "Join", `join-${pad(n)}`);
    created(j);
    relation(db, j, "JOIN_LEFT", d);
    relation(db, j, "JOIN_RIGHT", d);
    const keys = fact(db, j, "join.keys", '[["id","id"]]');
    cite(keys, table.versionId);
    line(db, keys, "schema", table.versionId);
    const cardinality = fact(db, j, "join.cardinality", "one-to-one");
    cite(cardinality, table.versionId);
    line(db, cardinality, "join-cardinality", table.versionId);
  }
}

export async function measureAnalyticalRead(
  options: { items?: number; runs?: number } = {},
): Promise<ReadLatency> {
  const items = options.items ?? 200;
  const runs = options.runs ?? 5;
  const dir = mkdtempSync(join(tmpdir(), "pki-analytical-latency-"));
  const db = openCanonicalDb(dir);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    registerConnectorInstance(db, "c1", "test-fixtures");
    db.transaction(() => seed(db, items));
    server = await startServer({
      token: TOKEN,
      allowedOrigins: [],
      connectors: { list: () => [], sync: async () => ({ error: "not-found" }) },
      db,
      dataDirectory: dir,
      egress: productEgress(db),
      ...productAdapters(dir),
      decisions: userDecisions,
      registry: createDerivativeRegistry({
        kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
        policy: defaultScopePolicy,
      }),
    });
    const port = server.port;
    const get = async () => {
      const started = performance.now();
      const res = await send(
        port,
        routes.analytical.path,
        { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` },
        routes.analytical.method,
      );
      const ms = performance.now() - started;
      const list = routes.analytical.response.parse(res.body);
      for (const [name, rows] of Object.entries({
        datasets: list.datasets,
        metrics: list.metrics,
        joins: list.joins,
      })) {
        if (rows.length !== items)
          throw new Error(`${name}: ${rows.length} listed, ${items} seeded`);
      }
      if (list.truncated) throw new Error("the list was truncated");
      return { ms, bytes: JSON.stringify(res.body).length };
    };
    await get(); // warm-up
    const samples: { ms: number; bytes: number }[] = [];
    for (let i = 0; i < runs; i++) samples.push(await get());
    const samplesMs = samples.map((s) => s.ms);
    const sorted = [...samplesMs].sort((a, b) => a - b);
    return {
      items,
      runs,
      samplesMs,
      medianMs: sorted[Math.floor(sorted.length / 2)] as number,
      maxMs: sorted[sorted.length - 1] as number,
      responseBytes: samples[0]?.bytes ?? 0,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpu: cpus()[0]?.model ?? "unknown",
    };
  } finally {
    await server?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [items, runs] = process.argv.slice(2);
  console.log(
    JSON.stringify(
      await measureAnalyticalRead({
        ...(items ? { items: Number(items) } : {}),
        ...(runs ? { runs: Number(runs) } : {}),
      }),
    ),
  );
}
