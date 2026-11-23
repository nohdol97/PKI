// P03-T3 `feedback.api` (P03-R9, R10, R14; C1c, C2b feed): the three feedback routes over HTTP and the feed's
// hiding. A target that is absent, deleted or hidden by the read gate answers the same `not-found` for a record,
// an undo and the list, and changes nothing. All data is synthetic.
import { routes, type RouteName } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
import {
  addEvidence,
  createDerivativeRegistry,
  defaultScopePolicy,
  insertItem,
  readSetting,
  recordFeedback,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveRelation,
  saveSourceRecord,
  userDecisions,
  type DerivativeRegistry,
  type ScopePolicy,
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

const TOKEN = "f".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const SECRET = ["secret"];
const AT = "2026-11-23T00:00:00.000Z";

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-feedback-api-"));
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

const refuseSecret: ScopePolicy = {
  ...defaultScopePolicy,
  allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
};
const hiding = (): DerivativeRegistry =>
  createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
    policy: refuseSecret,
  });

async function start(registry?: DerivativeRegistry) {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    decisions: userDecisions,
    ...(registry ? { registry } : {}),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
}
const call = (name: RouteName, body?: unknown) =>
  send((server as RunningServer).port, routes[name].path, valid, routes[name].method, body);

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-22T00:00:00Z",
} as const;

/** Two items, a fact and a relation between them, and an Insight over them, all resting on one source of `scope`. */
function world(name: string, scope: string[] | null = null) {
  const saved = saveSourceRecord(db, "c", {
    externalId: name,
    title: `제목 ${name}`,
    body: `${name} 본문`,
    accessScope: scope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const x = insertItem(db, { type: "Project", name: `X ${name}`, ...attrs });
  const y = insertItem(db, { type: "System", name: `Y ${name}`, ...attrs });
  const fact = saveFact(db, { itemId: x, kind: "target_date", value: "2026-12-05", ...attrs }).id;
  const relation = saveRelation(db, { subjectId: x, type: "DEPENDS_ON", objectId: y, ...attrs }).id;
  const cite = (target: { factId: number } | { relationId: number }) =>
    addEvidence(db, {
      target,
      sourceVersionId: versionId,
      start: 0,
      end: 1,
      quote: name.slice(0, 1),
    });
  const evidence = [cite({ factId: fact }), cite({ relationId: relation })];
  saveInsight(
    db,
    { rule: "dependency_delay", xItemId: x, yItemId: y },
    { state: "active", summary: `요약 ${name}`, evidenceIds: evidence, changedAt: AT },
  );
  const insight = db.all("SELECT id FROM insights WHERE summary = ?", [`요약 ${name}`])[0]
    ?.id as number;
  return { x, y, fact, relation, insight };
}
const feed = async () =>
  routes.insights.response.parse((await call("insights")).body).insights.map((i) => i.id);
const lines = async () => routes.feedbackList.response.parse((await call("feedbackList")).body);

describe("feedback.api: the contract (P03-C1c)", () => {
  it("records, lists and undoes a preference, and the feed follows (P03-C2b)", async () => {
    const w = world("a");
    await start();
    expect(await feed()).toEqual([w.insight]);

    const res = await call("feedbackRecord", {
      target: { kind: "insight", id: w.insight },
      kind: "irrelevant",
    });
    expect(res.status).toBe(200);
    const done = routes.feedbackRecord.response.parse(res.body);
    expect(done).toMatchObject({
      status: "applied",
      feedback: { kind: "irrelevant", class: "preference", label: "요약 a" },
    });
    // the same kind again answers the line that is there
    const again = routes.feedbackRecord.response.parse(
      (
        await call("feedbackRecord", {
          target: { kind: "insight", id: w.insight },
          kind: "irrelevant",
        })
      ).body,
    );
    expect(again.feedback?.id).toBe(done.feedback?.id);
    expect((await lines()).feedback).toHaveLength(1);
    expect(await feed()).toEqual([]);

    const undone = await call("feedbackUndo", { id: done.feedback?.id });
    expect(routes.feedbackUndo.response.parse(undone.body)).toEqual({ status: "applied" });
    expect(await feed()).toEqual([w.insight]);
    expect((await lines()).feedback).toEqual([]);
    expect(
      routes.feedbackUndo.response.parse(
        (await call("feedbackUndo", { id: done.feedback?.id })).body,
      ),
    ).toEqual({ status: "refused", reason: "nothing-to-undo" });
  });

  it("carries a correction's new state, takes it back, and refuses a pair the table does not have", async () => {
    const w = world("a");
    userDecisions.decide(db, { kind: "fact", id: w.fact }, "approve");
    await start();
    const wrong = routes.feedbackRecord.response.parse(
      (await call("feedbackRecord", { target: { kind: "fact", id: w.fact }, kind: "wrong_info" }))
        .body,
    );
    expect(wrong).toMatchObject({
      status: "applied",
      feedback: { class: "correction", label: "X a · target_date: 2026-12-05" },
      entry: { kind: "fact", id: w.fact, status: "disputed" },
    });
    const undone = routes.feedbackUndo.response.parse(
      (await call("feedbackUndo", { id: wrong.feedback?.id })).body,
    );
    expect(undone).toMatchObject({ status: "applied", entry: { status: "verified" } });

    const bad = await call("feedbackRecord", {
      target: { kind: "relation", id: w.relation },
      kind: "useful",
    });
    expect(bad).toMatchObject({ status: 400, body: { error: "bad-request" } });
  });
});

describe("feedback.api: the preference reaches the ranking (P5F-R4, P5F-C4)", () => {
  const ranked = async () =>
    routes.insights.response.parse((await call("insights")).body).insights.map((i) => ({
      id: i.id,
      preference: i.ranking.preference,
    }));

  it("puts the liked Insight first among equals, names the weight it used, and takes it back on undo", async () => {
    const a = world("a");
    const b = world("b");
    await start();
    expect((await ranked()).map((r) => r.id)).toEqual([a.insight, b.insight]);

    const done = routes.feedbackRecord.response.parse(
      (
        await call("feedbackRecord", {
          target: { kind: "insight", id: b.insight },
          kind: "important",
        })
      ).body,
    );
    expect(await ranked()).toEqual([
      { id: b.insight, preference: 100 },
      { id: a.insight, preference: 0 },
    ]);

    await call("feedbackUndo", { id: done.feedback?.id });
    expect((await ranked()).map((r) => r.id)).toEqual([a.insight, b.insight]);
  });
});

describe("feedback.api: the type step counts over the gate-shown Insights (P5F-R4, P03-R10)", () => {
  it("gives an Insight with no opinion of its own the same -25 in the list and in the evidence answer when a hidden sibling was disliked", async () => {
    const s = world("s");
    const b = world("b");
    await start();
    await call("setFeedbackSettings", { learned: true });
    for (const kind of ["useful", "irrelevant"] as const) {
      await call("feedbackRecord", { target: { kind: "insight", id: s.insight }, kind });
    }
    expect(await feed()).toEqual([b.insight]);

    const listed = routes.insights.response
      .parse((await call("insights")).body)
      .insights.find((i) => i.id === b.insight);
    const evidence = routes.insightEvidence.response.parse(
      (await call("insightEvidence", { insightId: b.insight })).body,
    );
    expect(listed?.ranking.preference).toBe(-25);
    expect("insight" in evidence && evidence.insight.ranking.preference).toBe(-25);
  });
});

describe("feedback.api: the type-step switch (P5F-R5, P5F-C5)", () => {
  it("reads and writes feedback.learned through the settings pair", async () => {
    await start();
    expect(routes.feedbackSettings.response.parse((await call("feedbackSettings")).body)).toEqual({
      learned: false,
    });
    const on = await call("setFeedbackSettings", { learned: true });
    expect(routes.setFeedbackSettings.response.parse(on.body)).toEqual({ learned: true });
    expect(readSetting(db, "feedback.learned")).toBe("on");
    expect(routes.feedbackSettings.response.parse((await call("feedbackSettings")).body)).toEqual({
      learned: true,
    });
    await call("setFeedbackSettings", { learned: false });
    expect(readSetting(db, "feedback.learned")).toBe("off");
  });
});

describe("feedback.api: a hidden target is no different from an absent one (P03-R10)", () => {
  it("answers not-found alike for a record, an undo and the list, and writes nothing", async () => {
    const open = world("open");
    const secret = world("secret", SECRET);
    // a line on the hidden Insight made before the policy hid it (as a policy change would leave it)
    db.transaction(() =>
      recordFeedback(
        db,
        userDecisions,
        { target: { kind: "insight", id: secret.insight }, kind: "useful" },
        AT,
      ),
    );
    db.transaction(() =>
      recordFeedback(
        db,
        userDecisions,
        { target: { kind: "insight", id: open.insight }, kind: "useful" },
        AT,
      ),
    );
    const hiddenLine = db.all("SELECT id FROM feedback WHERE insight_id = ?", [secret.insight])[0]
      ?.id as number;
    await start(hiding());

    const absent = await call("feedbackRecord", {
      target: { kind: "insight", id: 999_999 },
      kind: "useful",
    });
    expect(absent).toMatchObject({ status: 404, body: { error: "not-found" } });
    for (const target of [
      { kind: "insight", id: secret.insight },
      { kind: "item", id: secret.x },
      { kind: "fact", id: secret.fact },
      { kind: "relation", id: secret.relation },
    ] as const) {
      const kind = target.kind === "insight" || target.kind === "item" ? "mute" : "confirmed";
      const res = await call("feedbackRecord", { target, kind });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(absent.body);
    }
    expect(db.all("SELECT id FROM feedback").length).toBe(2);

    const hiddenUndo = await call("feedbackUndo", { id: hiddenLine });
    expect(hiddenUndo.status).toBe(404);
    expect(hiddenUndo.body).toEqual((await call("feedbackUndo", { id: 999_999 })).body);
    expect(db.all("SELECT undone_at FROM feedback WHERE id = ?", [hiddenLine])).toEqual([
      { undone_at: null },
    ]);

    const listed = await lines();
    expect(listed.feedback.map((f) => f.target)).toEqual([{ kind: "insight", id: open.insight }]);
    expect(JSON.stringify(listed)).not.toContain("secret");
  });
});
