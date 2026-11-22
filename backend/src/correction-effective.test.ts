// S01-T04 `correction.effective` and `semantic.api` (scope of the user's rows) over HTTP (S01-R15, R22,
// R23): a user action recomputes the rule in its own transaction, so the Insight follows the correction
// at once; the evidence API marks the user's rows as "사용자 입력" (an id, a target and a status, no text)
// and leaves out what the read gate hides; a row the user wrote is read under the lineage of its item
// (an item the user created has none). The user's rows are made through the API. All data is synthetic.
import { routes, type RouteName } from "@pki/contracts";
import { createProductRegistry, recomputeDependencyDelay } from "@pki/knowledge-engine";
import {
  addEvidence,
  automatedLifecycle,
  createDerivativeRegistry,
  defaultScopePolicy,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  userDecisions,
  type DerivativeRegistry,
  type EntryRef,
  type ScopePolicy,
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
const ORIGIN = "http://localhost:5173";
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const SECRET = ["secret"];
const LATE = "2026-12-20";
const EARLY = "2026-12-01";
const TARGET = "2026-12-10";

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-correction-effective-"));
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(registry?: DerivativeRegistry) {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [ORIGIN],
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

const registryWith = (policy: ScopePolicy) =>
  createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
    policy,
  });
/** Refuses to put the secret source with another one, and to show what rests on it alone. */
const secretAlone: ScopePolicy = {
  ...defaultScopePolicy,
  combinable: (scopes) => scopes.length < 2 || !scopes.some((s) => s?.includes("secret")),
  allows: (scopes) => !(scopes.length === 1 && scopes[0]?.includes("secret")),
};
/** Never shows what rests on the secret source, alone or with others. */
const secretHidden: ScopePolicy = {
  ...defaultScopePolicy,
  allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
};

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-22T00:00:00Z",
} as const;

function source(externalId: string, accessScope: string[] | null = null, newer = false) {
  const saved = saveSourceRecord(db, "c", {
    externalId,
    title: `제목 ${externalId}`,
    body: `${externalId} 본문`,
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  if (newer) {
    saveSourceRecord(db, "c", {
      externalId,
      title: `제목 ${externalId}`,
      body: `${externalId} 새 본문`,
      accessScope,
    });
  }
  return { sourceId: saved.sourceId, versionId, version: saved.version };
}
type Source = ReturnType<typeof source>;

const cite = (target: { factId: number } | { relationId: number }, s: Source) => {
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [s.versionId])[0]
    ?.body as string;
  addEvidence(db, {
    target,
    sourceVersionId: s.versionId,
    start: 0,
    end: [...body].length,
    quote: body,
  });
};
const item = (name: string) => {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  return id;
};
const fact = (itemId: number, kind: string, value: string, from: Source) => {
  const id = saveFact(db, { itemId, kind, value, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null);
  cite({ factId: id }, from);
  return id;
};
const dependsOn = (x: number, y: number, from: Source) => {
  const id = saveRelation(db, { subjectId: x, type: "DEPENDS_ON", objectId: y, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "relation", id }, "extraction", null);
  cite({ relationId: id }, from);
  return id;
};

/** X (target 12-10) depends on Y (completion `completion`), as one extraction from `a` and `b` wrote them. */
function pair(completion: string, a = source("a"), b = source("b")) {
  const x = item("X");
  const y = item("Y");
  fact(x, "target_date", TARGET, a);
  dependsOn(x, y, a);
  const done = fact(y, "completion_date", completion, b);
  return { x, y, done, a, b };
}
const insights = async () => routes.insights.response.parse((await call("insights")).body).insights;
const evidenceOf = async (insightId: number) =>
  routes.insightEvidence.response.parse((await call("insightEvidence", { insightId })).body);

describe("correction.effective: an action on a registry row recomputes the rule at once", () => {
  it("a value fixed to a later date makes the Insight, an earlier date resolves it, an undo goes back", async () => {
    const w = pair(EARLY);
    await start();
    expect(await insights()).toEqual([]);

    const fixed = routes.semanticCorrect.response.parse(
      (
        await call("semanticCorrect", {
          correction: { action: "replace", id: w.done, value: LATE },
        })
      ).body,
    );
    if (fixed.status !== "applied" || !fixed.entry) throw new Error("fix");
    const [made] = await insights();
    expect(made?.summary).toContain(LATE);
    // the evidence API: two source spans, and the user's row as "사용자 입력" with no span and no text
    const shown = await evidenceOf(made?.id as number);
    expect(shown.evidence).toHaveLength(2);
    expect(shown.userInputs).toEqual([{ target: "fact", id: fixed.entry.id, status: "verified" }]);
    expect(shown.insight.evidenceCount).toBe(3); // the user's row counts as one of what the Insight rests on
    expect(made?.evidenceCount).toBe(3); // and in the list
    // the Insight's own summary names the date; the user's row and the source spans carry no text of it
    expect(JSON.stringify(shown.userInputs)).not.toContain(LATE);
    expect(JSON.stringify(shown.evidence)).not.toContain(LATE);

    // fixing it to an earlier date: resolved, so nothing is listed
    const earlier = routes.semanticCorrect.response.parse(
      (
        await call("semanticCorrect", {
          correction: { action: "replace", id: fixed.entry.id, value: "2026-12-02" },
        })
      ).body,
    );
    if (earlier.status !== "applied" || !earlier.entry) throw new Error("fix again");
    expect(await insights()).toEqual([]);
    expect((await call("insightEvidence", { insightId: made?.id })).status).toBe(404);

    // the undo of the second fix gives the 12-20 row back, and the same Insight with it
    await call("semanticUndo", { kind: "fact", id: earlier.entry.id });
    const [back] = await insights();
    expect(back?.id).toBe(made?.id);
    expect(back?.summary).toContain(LATE);
  });

  it("a rejected fact leaves the Insight, an undo of the rejection gives it back", async () => {
    const w = pair(LATE);
    // an extraction's Insight is there before the user acts (the rule ran when it wrote the rows)
    await start();
    recomputeDependencyDelay(db, [w.x, w.y]);
    expect(await insights()).toHaveLength(1);

    await call("semanticDecide", { kind: "fact", id: w.done, action: "reject" });
    expect(await insights()).toEqual([]);
    await call("semanticUndo", { kind: "fact", id: w.done });
    expect(await insights()).toHaveLength(1);
  });

  it("approving a superseded old value with no current evidence makes it the Insight's, tied as a user input", async () => {
    const a = source("a");
    const b = source("b", null, true); // b has a newer version: its evidence is past
    const x = item("X");
    const y = item("Y");
    fact(x, "target_date", TARGET, a);
    dependsOn(x, y, a);
    const old = fact(y, "completion_date", LATE, b);
    await start();
    recomputeDependencyDelay(db, [x, y]);
    expect(await insights()).toEqual([]); // no current evidence: not valid

    await call("semanticDecide", { kind: "fact", id: old, action: "approve" });
    const [made] = await insights();
    expect(made?.summary).toContain(LATE);
    const shown = await evidenceOf(made?.id as number);
    expect(shown.userInputs).toEqual([{ target: "fact", id: old, status: "verified" }]);
    expect(shown.evidence).toHaveLength(2);
    expect(db.all("SELECT fact_id FROM insight_user_inputs")).toEqual([{ fact_id: old }]);
  });
});

describe("correction.effective: the lineage of the user's row decides what may be put together", () => {
  it("makes no Insight when the policy cannot put the source of the user's row with the others", async () => {
    const a = source("a");
    const secret = source("secret-doc", SECRET);
    const x = item("X");
    const y = item("Y");
    fact(x, "target_date", TARGET, a);
    dependsOn(x, y, a);
    fact(y, "memo", "메모", secret); // Y's only source is the secret one
    await start(registryWith(secretAlone));
    // the user writes Y's late completion date: it is on Y, so its lineage is Y's (the secret source)
    const added = routes.semanticCorrect.response.parse(
      (
        await call("semanticCorrect", {
          correction: {
            action: "add",
            entry: { kind: "fact", itemId: y, factKind: "completion_date", value: LATE },
          },
        })
      ).body,
    );
    expect(added.status).toBe("applied");
    expect(await insights()).toEqual([]);
    expect(db.all("SELECT count(*) AS n FROM insights")[0]?.n).toBe(0);
  });

  it("makes the Insight when the policy allows the combination (the control of the case above)", async () => {
    const a = source("a");
    const secret = source("secret-doc", SECRET);
    const x = item("X");
    const y = item("Y");
    fact(x, "target_date", TARGET, a);
    dependsOn(x, y, a);
    fact(y, "memo", "메모", secret);
    await start(registryWith({ ...defaultScopePolicy, allows: () => true }));
    await call("semanticCorrect", {
      correction: {
        action: "add",
        entry: { kind: "fact", itemId: y, factKind: "completion_date", value: LATE },
      },
    });
    expect(db.all("SELECT count(*) AS n FROM insights WHERE state = 'active'")[0]?.n).toBe(1);
    expect(await insights()).toHaveLength(1);
  });

  it("hides an Insight whose user input rests on a source the policy denies, and its evidence", async () => {
    const a = source("a");
    const secret = source("secret-doc", SECRET);
    const x = item("X");
    const y = item("Y");
    fact(x, "target_date", TARGET, a);
    dependsOn(x, y, a);
    fact(y, "memo", "메모", secret);
    // the user wrote Y's date, the rule ran: the Insight cites only `a`'s evidence, yet it rests on Y's sources too
    userDecisions.add(db, { kind: "fact", itemId: y, factKind: "completion_date", value: LATE });
    recomputeDependencyDelay(db, [x, y]);
    expect(db.all("SELECT count(*) AS n FROM insights WHERE state = 'active'")[0]?.n).toBe(1);
    await start(registryWith(secretHidden));
    expect(await insights()).toEqual([]);
    const id = db.all("SELECT id FROM insights")[0]?.id as number;
    expect((await call("insightEvidence", { insightId: id })).status).toBe(404);
  });
});

describe("correction.effective: the evidence API leaves out a user input the policy hides", () => {
  /** Denies exactly a pair of scopes one of which is the secret one: the user's row's, not the Insight's. */
  const secretPair: ScopePolicy = {
    ...defaultScopePolicy,
    allows: (scopes) => !(scopes.length === 2 && scopes.some((s) => s?.includes("secret"))),
  };

  it("lists the Insight and what it shows, not a user's row whose own lineage the policy denies", async () => {
    const a = source("a");
    const team = source("d", ["team"]);
    const secret = source("secret-doc", SECRET);
    const x = item("X");
    const y = item("Y");
    fact(x, "target_date", TARGET, team);
    dependsOn(x, y, a);
    fact(y, "memo", "메모", secret);
    const written = userDecisions.add(db, {
      kind: "fact",
      itemId: y,
      factKind: "completion_date",
      value: LATE,
    });
    if (written.status !== "applied") throw new Error("add");
    recomputeDependencyDelay(db, [x, y]);
    // the Insight rests on three scopes (team, open, secret): shown; the user's row on Y's two (open, secret): not
    await start(registryWith(secretPair));
    const [made] = await insights();
    expect(made).toBeDefined();
    const shown = await evidenceOf(made?.id as number);
    expect(shown.userInputs).toEqual([]);
    expect(shown.evidence).toHaveLength(2);
    expect(shown.insight.evidenceCount).toBe(2);
    expect(made?.evidenceCount).toBe(2);
  });
});

describe("correction.effective: the evidence API's user inputs, relation side and status", () => {
  /** Denies what rests on the secret source alone; any set of several scopes may be shown and combined. */
  const secretSingle: ScopePolicy = {
    ...defaultScopePolicy,
    allows: (scopes) => !(scopes.length === 1 && scopes[0]?.includes("secret")),
  };

  it("leaves out an approved relation whose own lineage the policy denies; the count follows", async () => {
    const a = source("a");
    const secret = source("secret-doc", SECRET, true); // its evidence is past: approving needs no current evidence
    const x = item("X");
    const y = item("Y");
    fact(x, "target_date", TARGET, a);
    fact(y, "completion_date", LATE, a);
    const rel = dependsOn(x, y, secret);
    userDecisions.decide(db, { kind: "relation", id: rel }, "approve");
    recomputeDependencyDelay(db, [x, y]);
    expect(db.all("SELECT relation_id FROM insight_user_inputs")).toEqual([{ relation_id: rel }]);
    await start(registryWith(secretSingle));
    const [made] = await insights();
    expect(made?.evidenceCount).toBe(2);
    const shown = await evidenceOf(made?.id as number);
    expect(shown.userInputs).toEqual([]);
    expect(shown.insight.evidenceCount).toBe(2);
  });

  it("lists an approved relation when the policy allows it, and counts it", async () => {
    const a = source("a");
    const secret = source("secret-doc", SECRET, true);
    const x = item("X");
    const y = item("Y");
    fact(x, "target_date", TARGET, a);
    fact(y, "completion_date", LATE, a);
    const rel = dependsOn(x, y, secret);
    userDecisions.decide(db, { kind: "relation", id: rel }, "approve");
    recomputeDependencyDelay(db, [x, y]);
    await start(registryWith(defaultScopePolicy));
    const [made] = await insights();
    const shown = await evidenceOf(made?.id as number);
    expect(shown.userInputs).toEqual([{ target: "relation", id: rel, status: "verified" }]);
    expect(shown.insight.evidenceCount).toBe(3);
    expect(made?.evidenceCount).toBe(3);
  });

  it("hides only the relation the user wrote when one end is an item the user created", async () => {
    const a = source("a");
    const secret = source("secret-doc", SECRET);
    const created = userDecisions.add(db, { kind: "item", type: "Project", name: "내 항목" });
    if (created.status !== "applied") throw new Error("add");
    const x = created.ref.id;
    const y = item("Y");
    fact(x, "target_date", TARGET, a); // an extraction's fact on the user's item: its lineage is its own
    fact(y, "completion_date", LATE, secret);
    const written = userDecisions.add(db, {
      kind: "relation",
      subjectId: x,
      type: "DEPENDS_ON",
      objectId: y,
    });
    if (written.status !== "applied") throw new Error("add");
    recomputeDependencyDelay(db, [x, y]);
    await start(registryWith(secretSingle));
    const [made] = await insights(); // rests on `a` and the secret source together: shown
    expect(made).toBeDefined();
    const shown = await evidenceOf(made?.id as number);
    expect(shown.userInputs).toEqual([]); // the relation's own lineage is the secret source alone
    expect(shown.evidence).toHaveLength(1); // the completion date's evidence rests on the secret source alone too
    expect(shown.insight.evidenceCount).toBe(1);
  });

  it("reports the status of a user input that is not verified (a disputed row the user wrote still counts)", async () => {
    const w = pair(EARLY);
    const written = userDecisions.add(db, {
      kind: "fact",
      itemId: w.y,
      factKind: "completion_date",
      value: LATE,
    });
    if (written.status !== "applied") throw new Error("add");
    userDecisions.decide(db, written.ref, "dispute");
    recomputeDependencyDelay(db, [w.x, w.y]);
    await start();
    const [made] = await insights();
    expect((await evidenceOf(made?.id as number)).userInputs).toEqual([
      { target: "fact", id: written.ref.id, status: "disputed" },
    ]);
  });
});

describe("semantic.api: the scope of the rows the user wrote", () => {
  const writtenOn = (itemId: number, value: string): EntryRef => {
    const r = userDecisions.add(db, { kind: "fact", itemId, factKind: "memo", value });
    if (r.status !== "applied") throw new Error("add");
    return r.ref;
  };

  it("hides a fact the user wrote on an item whose only source the policy denies", async () => {
    const secret = source("secret-doc", SECRET);
    const shownSource = source("open");
    const hiddenItem = item("숨은 항목");
    const openItem = item("보이는 항목");
    fact(hiddenItem, "memo", "원본 글", secret);
    fact(openItem, "memo", "원본 글2", shownSource);
    const hiddenFact = writtenOn(hiddenItem, "사용자 글 가");
    const openFact = writtenOn(openItem, "사용자 글 나");
    await start(registryWith(secretHidden));

    const list = routes.semantic.response.parse((await call("semantic")).body);
    expect(list.items.map((i) => i.id)).toEqual([openItem]);
    expect(list.items[0]?.facts.map((f) => f.id)).toContain(openFact.id);
    // the fact itself is hidden whatever the list does with its item: the same answer as for an absent row
    expect((await call("semanticHistory", hiddenFact)).status).toBe(404);
    expect((await call("semanticHistory", openFact)).status).toBe(200);
    expect(
      (await call("semanticDecide", { kind: "fact", id: hiddenFact.id, action: "dispute" })).status,
    ).toBe(404);
  });

  it("shows a user's fact on an item the user created while the extraction's fact on it, from a denied source, is hidden", async () => {
    const secret = source("secret-doc", SECRET);
    const created = userDecisions.add(db, { kind: "item", type: "Project", name: "내 항목" });
    if (created.status !== "applied") throw new Error("add");
    fact(created.ref.id, "memo", "원본 글", secret);
    const mine = writtenOn(created.ref.id, "사용자 글");
    await start(registryWith(secretHidden));
    const list = routes.semantic.response.parse((await call("semantic")).body);
    const row = list.items.find((i) => i.id === created.ref.id);
    expect(row).toBeDefined(); // an item the user created follows no source
    expect(row?.facts.map((f) => f.id)).toEqual([mine.id]);
  });
});
