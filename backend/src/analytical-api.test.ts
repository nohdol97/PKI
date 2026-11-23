// S03-T06 `gate.user-approve` over HTTP (G-C1, S03-R14): the user's approval of a check-needing fact with an
// unmet data condition is a code in a 200 body (`data-check-unmet`) with the names of every unmet condition,
// never a text; the body parses with the contract. T08 adds the read side to this file. All data is synthetic.
import { routes, type RouteName } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
import {
  addEvidence,
  automatedLifecycle,
  createDerivativeRegistry,
  dataChecksUnmet,
  defaultScopePolicy,
  saveCheckLine,
  saveDatasetTable,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  userDecisions,
  type SqlDriver,
} from "@pki/storage";
import { send, dirTemplate } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const TOKEN = "s".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-analytical-api-"));
  seedDataDir(dir);
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (name: RouteName, body?: unknown) =>
  send(
    (server as RunningServer).port,
    routes[name].path,
    { host: `127.0.0.1:${(server as RunningServer).port}`, authorization: `Bearer ${TOKEN}` },
    routes[name].method,
    body,
  );

describe("POST /api/semantic/decide (analytical gate)", () => {
  it("G-C1: approving a calculation with no table and no check line answers refused with data-check-unmet and every unmet name, and changes nothing", async () => {
    const saved = saveSourceRecord(db, "c", {
      externalId: "doc",
      title: "doc",
      body: "매출 합계 정의",
    });
    if (saved.status !== "created") throw new Error(saved.status);
    const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    const metric = insertItem(db, {
      type: "Metric",
      name: "매출",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-23T00:00:00Z",
    });
    const calc = saveFact(db, {
      itemId: metric,
      kind: "metric.calculation",
      value: '{"aggregation":"count"}',
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-23T00:00:00Z",
    }).id;
    addEvidence(db, {
      target: { factId: calc },
      sourceVersionId: versionId,
      start: 0,
      end: 2,
      quote: "매출",
    });
    server = await startServer({
      token: TOKEN,
      allowedOrigins: ["http://localhost:5173"],
      connectors,
      db,
      dataDirectory: dir,
      egress: productEgress(db),
      ...productAdapters(dir),
      decisions: userDecisions,
    });

    const res = await call("semanticDecide", { kind: "fact", id: calc, action: "approve" });
    expect(res.status).toBe(200);
    expect(routes.semanticDecide.response.parse(res.body)).toEqual({
      status: "refused",
      reason: "data-check-unmet",
      unmet: ["no-dataset", "check-missing"],
    });
    expect(db.all("SELECT status FROM facts WHERE id = ?", [calc])).toEqual([
      { status: "candidate" },
    ]);
    expect(db.all("SELECT 1 FROM fact_history WHERE fact_id = ?", [calc])).toEqual([]);
  });
});

// S03-T08 Phase B: the read, the check request and the /correct pieces through the booted server, real storage and
// a real registry. The tables have a header cell and a fixture of synthetic text only.
describe("analytical routes (S03-R19)", () => {
  const attrs = {
    epistemic: "explicit",
    status: "candidate",
    validAt: null,
    observedAt: "2026-11-23T00:00:00Z",
  } as const;
  const blocks = [
    { start: 0, end: 2, locator: { format: "csv", record: 1, line: 1, field: 1 } },
    { start: 3, end: 9, locator: { format: "csv", record: 1, line: 1, field: 2 } },
  ];
  const CALC = '{"aggregation":"sum","column":"amount"}';
  const woken = vi.fn();

  async function start(registry?: ReturnType<typeof createDerivativeRegistry>) {
    server = await startServer({
      token: TOKEN,
      allowedOrigins: [],
      connectors,
      db,
      dataDirectory: dir,
      egress: productEgress(db),
      ...productAdapters(dir),
      decisions: userDecisions,
      onRunConditionsChanged: woken,
      ...(registry ? { registry } : {}),
    });
  }
  const restricting = () =>
    createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy: {
        ...defaultScopePolicy,
        allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
      },
    });

  /** A Metric on a Dataset bound to a table source (restricted to `scope`), with a column fact and a check line. */
  function world(scope: string[] | null) {
    const saved = saveSourceRecord(db, "c", {
      namespace: "",
      externalId: "orders",
      title: "orders",
      body: "id\tamount\n1\t10",
      blocks,
      accessScope: scope,
    } as Parameters<typeof saveSourceRecord>[2]);
    if (saved.status !== "created") throw new Error(saved.status);
    const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    const dataset = insertItem(db, { type: "Dataset", name: "orders", ...attrs });
    const metric = insertItem(db, { type: "Metric", name: "매출", ...attrs });
    for (const id of [dataset, metric])
      automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
    saveDatasetTable(db, { itemId: dataset, sourceId: saved.sourceId, key: "", rowCount: 1 });
    const column = saveFact(db, {
      itemId: dataset,
      kind: "dataset.column",
      value: "amount",
      ...attrs,
    }).id;
    addEvidence(db, {
      target: { factId: column },
      sourceVersionId: versionId,
      start: 3,
      end: 9,
      quote: "amount",
    });
    const calc = saveFact(db, {
      itemId: metric,
      kind: "metric.calculation",
      value: CALC,
      ...attrs,
    }).id;
    saveCheckLine(db, {
      factId: calc,
      check: "schema",
      passed: true,
      failure: null,
      examined: 1,
      violations: 0,
      skipped: 0,
      versionId,
      otherVersionId: null,
      at: "2026-11-23T00:00:00.000Z",
    });
    db.run(
      "INSERT INTO relations (subject_id, type, object_id, status, epistemic, valid_at, observed_at) VALUES (?, 'MEASURED_ON', ?, 'candidate', 'explicit', NULL, 't')",
      [metric, dataset],
    );
    return { dataset, metric, calc, sourceId: saved.sourceId };
  }

  it("GET /api/analytical parses with the contract and shows the link; a table source the policy hides takes its Dataset's table and check results out", async () => {
    const w = world(null);
    await start(restricting());
    const open = await call("analytical");
    expect(open.status).toBe(200);
    expect(routes.analytical.response.parse(open.body)).toEqual(open.body);
    const metric = (
      open.body as {
        metrics: { calculations: { checks: unknown[] }[]; datasets: { tables: unknown[] }[] }[];
      }
    ).metrics[0];
    expect(metric?.datasets[0]?.tables).toHaveLength(1);
    expect(metric?.calculations[0]?.checks).toHaveLength(1);
    await server?.close();

    db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
      JSON.stringify(["secret"]),
      w.sourceId,
    ]);
    await start(restricting());
    const hidden = await call("analytical");
    const text = JSON.stringify(hidden.body);
    expect(text).not.toContain('"schema"');
    expect(text).not.toContain('"tableId"');
  });

  it("POST /api/analytical/check queues the job, answers its id and wakes the runner; an absent item is a bare not-found", async () => {
    const w = world(null);
    await start();
    const res = await call("analyticalCheck", { itemId: w.dataset });
    expect(routes.analyticalCheck.response.parse(res.body)).toEqual({
      jobIds: [expect.any(Number)],
    });
    expect(woken).toHaveBeenCalled();
    const missing = await call("analyticalCheck", { itemId: 99999 });
    expect(missing).toEqual({ status: 404, body: { error: "not-found" } });
    const extra = await call("analyticalCheck", { itemId: w.dataset, query: "sum(amount)" });
    expect(extra.status).toBe(400);
  });

  it("POST /api/semantic/correct stores pieces as the canonical text and answers value-exists for the same value in another order and case", async () => {
    const w = world(null);
    await start();
    const add = (value: unknown) =>
      call("semanticCorrect", {
        correction: {
          action: "add",
          entry: { kind: "fact", itemId: w.metric, factKind: "metric.calculation", value },
        },
      });
    const first = await add({ column: " Amount ", aggregation: "count_distinct" });
    expect(first.body).toMatchObject({ status: "applied" });
    expect(
      db.all("SELECT value FROM facts WHERE kind = 'metric.calculation' ORDER BY id DESC")[0],
    ).toEqual({
      value: '{"aggregation":"count_distinct","column":"amount"}',
    });
    const again = await add({ aggregation: "count_distinct", column: "AMOUNT" });
    expect(again.body).toMatchObject({ status: "refused", reason: "value-exists" });
    const bad = await add(["sum", "amount"]);
    expect(bad).toEqual({ status: 400, body: { error: "bad-request" } });
    expect(JSON.stringify(bad.body)).not.toContain("amount");
  });

  // #209 B-F1 (F209-R1, R2): a refusal answers over the rows the caller sees; blocking is over every row.
  describe("refusal answers over shown rows (F209-C1, C2)", () => {
    const secret = (externalId: string) => {
      const saved = saveSourceRecord(db, "c", {
        externalId,
        title: externalId,
        body: "hidden text",
        accessScope: ["secret"],
      });
      if (saved.status !== "created") throw new Error(saved.status);
      return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    };
    const unmetOf = async (calc: number) => {
      const read = routes.analytical.response.parse((await call("analytical")).body);
      return read.metrics.flatMap((m) => m.calculations).find((c) => c.id === calc)?.unmet;
    };
    const approve = async (calc: number) =>
      routes.semanticDecide.response.parse(
        (await call("semanticDecide", { kind: "fact", id: calc, action: "approve" })).body,
      );
    const failSchema = (calc: number) =>
      db.run(
        "UPDATE analytical_checks SET passed = 0, failure_code = 'column-missing' WHERE fact_id = ? AND check_name = 'schema'",
        [calc],
      );

    it("F209-C1 (가): the refusal of the approval of a calculation whose failed line is hidden lists what the read lists, never the hidden line's name, on both seats", async () => {
      const w = world(["secret"]);
      failSchema(w.calc);
      expect(dataChecksUnmet(db, { kind: "fact", id: w.calc })).toContain("schema"); // the premise: all rows block with it
      await start(restricting());
      const read = await unmetOf(w.calc);
      expect(read).toBeDefined();
      expect(read).not.toContain("schema");
      expect(await approve(w.calc)).toEqual({
        status: "refused",
        reason: "data-check-unmet",
        unmet: read,
      });
      const feedback = await call("feedbackRecord", {
        target: { kind: "fact", id: w.calc },
        kind: "confirmed",
      });
      expect(routes.feedbackRecord.response.parse(feedback.body)).toEqual({
        status: "refused",
        reason: "data-check-unmet",
        unmet: read,
      });
      expect(db.all("SELECT status FROM facts WHERE id = ?", [w.calc])).toEqual([
        { status: "candidate" },
      ]);
      expect(db.all("SELECT 1 FROM fact_history WHERE fact_id = ?", [w.calc])).toEqual([]);
    });

    it("F209-C1 (나): when only a hidden rival blocks, the read lists nothing and the refusal answers check-missing alone", async () => {
      const w = world(null);
      // an item the user wrote has no lineage of its own, so this Metric stays shown while its relation is hidden
      const made = userDecisions.add(db, { kind: "item", type: "Metric", name: "회수율" });
      if (made.status !== "applied") throw new Error("not added");
      const metric = made.ref.id;
      const calc = saveFact(db, {
        itemId: metric,
        kind: "metric.calculation",
        value: CALC,
        ...attrs,
      }).id;
      const link = (object: number) =>
        db.run(
          "INSERT INTO relations (subject_id, type, object_id, status, epistemic, valid_at, observed_at) VALUES (?, 'MEASURED_ON', ?, 'candidate', 'explicit', NULL, 't')",
          [metric, object],
        ).lastInsertRowid as number;
      link(w.dataset);
      const rival = link(insertItem(db, { type: "Dataset", name: "other", ...attrs }));
      addEvidence(db, {
        target: { relationId: rival },
        sourceVersionId: secret("hidden-rival"),
        start: 0,
        end: 6,
        quote: "hidden",
      });
      // a relation's evidence erases the lines it makes stale: the passing lines are written last
      const table = db.all("SELECT max(id) AS id FROM source_versions WHERE source_id = ?", [
        w.sourceId,
      ])[0]?.id as number;
      for (const check of ["schema", "aggregation"] as const)
        saveCheckLine(db, {
          factId: calc,
          check,
          passed: true,
          failure: null,
          examined: 1,
          violations: 0,
          skipped: 0,
          versionId: table,
          otherVersionId: null,
          at: "2026-11-23T00:00:00.000Z",
        });
      expect(dataChecksUnmet(db, { kind: "fact", id: calc })).toEqual(["spec-conflict"]); // the premise
      await start(restricting());
      expect(await unmetOf(calc)).toEqual([]);
      expect(await approve(calc)).toEqual({
        status: "refused",
        reason: "data-check-unmet",
        unmet: ["check-missing"],
      });
      expect(db.all("SELECT status FROM facts WHERE id = ?", [calc])).toEqual([
        { status: "candidate" },
      ]);
    });

    it("F209-C2: the undo of a directly added item counts only the facts the caller sees in held", async () => {
      await start(restricting());
      const added = routes.semanticCorrect.response.parse(
        (
          await call("semanticCorrect", {
            correction: { action: "add", entry: { kind: "item", type: "Metric", name: "새 항목" } },
          })
        ).body,
      );
      if (added.status !== "applied" || !added.entry) throw new Error("not added");
      saveFact(db, { itemId: added.entry.id, kind: "note", value: "open", ...attrs });
      const hidden = saveFact(db, {
        itemId: added.entry.id,
        kind: "note",
        value: "closed",
        ...attrs,
      }).id;
      addEvidence(db, {
        target: { factId: hidden },
        sourceVersionId: secret("hidden-fact"),
        start: 0,
        end: 6,
        quote: "hidden",
      });
      const undone = await call("semanticUndo", { kind: "item", id: added.entry.id });
      expect(routes.semanticUndo.response.parse(undone.body)).toEqual({
        status: "refused",
        reason: "existing-data-violation",
        held: { facts: 1, relations: 0, merges: 0, distinct: 0, splitMoves: 0 },
      });
    });
  });
});
