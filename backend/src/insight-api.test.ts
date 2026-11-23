// P01-T03: the Insight API (P01-R13, R14, R16). `GET /api/insights` lists the active Insights highest
// score first, each with its type, fact lines, reason, ranking and notification mark; an interpretation
// replaces the reason's text; a resolved Insight is not listed. `GET /api/insights/types` reports the
// 13 types of the type table. Rows are seeded straight into the store over one imported source.
import { INSIGHT_TYPE_NAMES, routes } from "@pki/contracts";
import {
  addEvidence,
  insertItem,
  insightBasis,
  readInsightById,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveSourceRecord,
  writeInsightInterpretation,
  type SqlDriver,
} from "@pki/storage";
import { dirTemplate, send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const TOKEN = "a".repeat(43);
const ORIGIN = "http://localhost:5173";
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const NOW = Date.parse("2026-11-23T00:00:00Z");
let dir: string;
let db: SqlDriver;
let server: RunningServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-insight-api-"));
  seedDataDir(dir);
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    now: () => NOW,
  });
});
afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const good = () => ({ host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` });
const list = () =>
  send(server.port, routes.insights.path, good(), routes.insights.method).then((r) => {
    expect(r.status).toBe(200);
    return routes.insights.response.parse(r.body).insights;
  });

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-22T00:00:00Z",
} as const;

function versionId(): number {
  const saved = saveSourceRecord(db, "c", { externalId: "s", title: "제목", body: "합성 등대" });
  if (saved.status !== "created") throw new Error(saved.status);
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}

/** An Insight over two fresh items, with one fact quoted from `version`. */
function seed(rule: string, name: string, version: number, content: Record<string, unknown>) {
  const x = insertItem(db, { ...attrs, type: "Project", name: `X${name}` });
  const y = insertItem(db, { ...attrs, type: "System", name: `Y${name}` });
  const fact = saveFact(db, { ...attrs, itemId: x, kind: "target_date", value: "2026-12-05" });
  const evidenceId = addEvidence(db, {
    target: { factId: fact.id },
    sourceVersionId: version,
    start: 0,
    end: 2,
    quote: "합성",
  });
  const key = { rule, xItemId: x, yItemId: y };
  saveInsight(db, key, {
    state: "active",
    summary: `요약 ${name}`,
    evidenceIds: [evidenceId],
    ...content,
  });
  const id = db.all("SELECT id FROM insights WHERE summary = ?", [`요약 ${name}`])[0]?.id as number;
  return { id, key };
}

describe("Insight API", () => {
  it("lists active Insights highest score first, each with its type, fact lines, reason, ranking and notification mark (C2d)", async () => {
    const version = versionId();
    // Q is saved first (the lower id) and must still come second
    const q = seed("new_relation", "q", version, {
      factLines: ["Q 줄"],
      confidence: 30,
    });
    const p = seed("dependency_delay", "p", version, {
      factLines: ["P 줄 하나", "P 줄 둘"],
      reasoningSummary: "코드 이유",
      confidence: 80,
      urgencyDate: "2026-11-25",
    });
    const rows = await list();
    expect(rows.map((r) => r.id)).toEqual([p.id, q.id]);
    expect(rows[0]).toMatchObject({
      type: "dependency_delay",
      factLines: ["P 줄 하나", "P 줄 둘"],
      reasoningSummary: "코드 이유",
      reasoningBy: "code",
      confidence: 80,
      autoNotifyExcluded: false,
    });
    expect(rows[0]?.ranking.score).toBeGreaterThan(rows[1]?.ranking.score as number);
    expect(rows[1]).toMatchObject({
      type: "new_relation",
      reasoningSummary: null,
      reasoningBy: null,
      autoNotifyExcluded: true,
    });

    // an interpretation replaces the reason's text
    const stored = readInsightById(db, p.id);
    if (!stored) throw new Error("no insight");
    expect(
      writeInsightInterpretation(db, p.id, insightBasis(stored), {
        reasoningSummary: "해석 이유",
        impact: 90,
        actionability: 60,
      }),
    ).toBe(true);
    expect((await list())[0]).toMatchObject({ reasoningSummary: "해석 이유", reasoningBy: "llm" });

    // a resolved Insight is not listed
    saveInsight(db, q.key, { state: "resolved" });
    expect((await list()).map((r) => r.id)).toEqual([p.id]);
  });

  it("reports the 13 types, with a reason for each unsupported one (C1c)", async () => {
    const res = await send(
      server.port,
      routes.insightTypes.path,
      good(),
      routes.insightTypes.method,
    );
    expect(res.status).toBe(200);
    const { types } = routes.insightTypes.response.parse(res.body);
    expect(types.map((t) => t.type)).toEqual([...INSIGHT_TYPE_NAMES]);
    for (const t of types) {
      if (t.status === "unsupported") expect(t.reason?.length).toBeGreaterThan(0);
      else expect(t.reason).toBeNull();
    }
    expect(types.some((t) => t.status === "unsupported")).toBe(true);
  });
});
