// S03-T06 `gate.user-approve` over HTTP (G-C1, S03-R14): the user's approval of a check-needing fact with an
// unmet data condition is a code in a 200 body (`data-check-unmet`) with the names of every unmet condition,
// never a text; the body parses with the contract. T08 adds the read side to this file. All data is synthetic.
import { routes, type RouteName } from "@pki/contracts";
import {
  addEvidence,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  userDecisions,
  type SqlDriver,
} from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "s".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-analytical-api-"));
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
