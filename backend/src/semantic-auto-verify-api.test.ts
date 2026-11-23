// S01-T05 rework (review M2): the judgement runs after the user's actions over HTTP, in the action's own
// transaction (`judgeAgain` in server.ts; the split route calls the judgement alone, its rule half being
// the receiver's). A value the user writes or approves is valid under R15, so a promoted sibling goes
// back; an undo can give a row back to the policy while its grounds are gone.
// With the setting key never written the action leaves the registry as before. All data is synthetic.
import { routes } from "@pki/contracts";
import { assessAutoVerify, AUTO_VERIFY_SETTING } from "@pki/knowledge-engine";
import {
  addEvidence,
  automatedLifecycle,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  userDecisions,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { send, dirTemplate } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const TOKEN = "u".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const DATE = "2026-12-05";
const RIVAL = "2026-12-19";
let dir: string;
let db: SqlDriver;
let server: RunningServer;
let headers: Record<string, string>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-auto-verify-api-"));
  seedDataDir(dir);
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    decisions: userDecisions,
  });
  headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
});
afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = "2026-11-23T00:00:00.000Z";
const attrs = { epistemic: "explicit", status: "candidate", validAt: null, observedAt: T } as const;
const post = (
  name: "semanticDecide" | "semanticUndo" | "semanticCorrect" | "entitySplit",
  body: unknown,
) => send(server.port, routes[name].path, headers, "POST", body);

/** A fact with current evidence from two sources, promoted by the policy while the setting is on. */
function promoted() {
  writeSetting(db, AUTO_VERIFY_SETTING, "on");
  const item = insertItem(db, { type: "Project", name: "Alpha", ...attrs });
  const id = saveFact(db, { itemId: item, kind: "target_date", value: DATE, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null, T);
  const evidence: number[] = [];
  for (const tag of ["a", "b"]) {
    const body = `${tag} says ${DATE}`;
    const saved = saveSourceRecord(db, "c", { externalId: tag, title: tag, body });
    if (saved.status !== "created") throw new Error("expected a new version");
    const versionId = db.all("SELECT id FROM source_versions WHERE source_id = ?", [
      saved.sourceId,
    ])[0]?.id as number;
    evidence.push(
      addEvidence(db, {
        target: { factId: id },
        sourceVersionId: versionId,
        start: body.indexOf(DATE),
        end: body.indexOf(DATE) + DATE.length,
        quote: DATE,
      }),
    );
  }
  expect(assessAutoVerify(db, { kind: "fact", id }, T).status).toBe("applied");
  return { item, id, evidence };
}
const status = (id: number) => db.all("SELECT status FROM facts WHERE id = ?", [id])[0]?.status;
const actions = (id: number) =>
  db
    .all("SELECT actor, action FROM fact_history WHERE fact_id = ? ORDER BY seq", [id])
    .map((r) => `${r.actor}:${r.action}`);

describe("the judgement after a user action (review M2)", () => {
  it("P5: a value the user writes takes the promoted sibling back to candidate", async () => {
    const { item, id } = promoted();
    const res = await post("semanticCorrect", {
      correction: {
        action: "add",
        entry: { kind: "fact", itemId: item, factKind: "target_date", value: RIVAL },
      },
    });
    expect(res.status).toBe(200);
    expect(status(id)).toBe("candidate");
    expect(actions(id).at(-1)).toBe("policy:auto-verify-reverted");
  });

  it("a value fix to another value does the same (the fixed row is the user's valid value)", async () => {
    const { item, id } = promoted();
    const other = saveFact(db, {
      itemId: item,
      kind: "target_date",
      value: "2026-12-11",
      ...attrs,
    });
    automatedLifecycle.created(db, { kind: "fact", id: other.id }, "extraction", null, T);
    // a candidate with no evidence is not valid; the user's fix of it makes a valid row
    const res = await post("semanticCorrect", {
      correction: { action: "replace", id: other.id, value: RIVAL },
    });
    expect(res.status).toBe(200);
    expect(status(id)).toBe("candidate");
  });

  it("P6: dispute, a source goes, undo: the row the policy owns again is taken back", async () => {
    const { id, evidence } = promoted();
    expect((await post("semanticDecide", { kind: "fact", id, action: "dispute" })).status).toBe(
      200,
    );
    expect(status(id)).toBe("disputed");
    db.run("DELETE FROM evidence WHERE id = ?", [evidence[1] as number]);
    const undone = await post("semanticUndo", { kind: "fact", id });
    expect(undone.status).toBe(200);
    expect(status(id)).toBe("candidate");
    expect(actions(id).at(-1)).toBe("policy:auto-verify-reverted");
  });

  it("a refusal and an unchanged answer judge nothing", async () => {
    const { id } = promoted();
    const before = actions(id);
    const res = await post("semanticDecide", { kind: "fact", id, action: "reject" }); // verified: no such transition
    expect(res.body).toMatchObject({ status: "refused", reason: "invalid-transition" });
    expect(actions(id)).toEqual(before);
  });

  it("with the setting key never written an action judges nothing", async () => {
    const item = insertItem(db, { type: "Project", name: "Beta", ...attrs });
    const id = saveFact(db, { itemId: item, kind: "target_date", value: DATE, ...attrs }).id;
    automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null, T);
    await post("semanticCorrect", {
      correction: {
        action: "add",
        entry: { kind: "fact", itemId: item, factKind: "target_date", value: RIVAL },
      },
    });
    expect(db.all("SELECT 1 FROM fact_history WHERE actor = 'policy'")).toEqual([]);
  });
});

describe("the judgement after a split (S02-T05, S01-R9 condition 5)", () => {
  it("a split that moves the rival value away lets the policy judge the item's remaining value again, in the split's own request", async () => {
    const { item, id } = promoted();
    // a rival value on the same item, with current evidence: condition 5 no longer holds, the policy takes `id` back
    const rival = saveFact(db, { itemId: item, kind: "target_date", value: RIVAL, ...attrs }).id;
    automatedLifecycle.created(db, { kind: "fact", id: rival }, "extraction", null, T);
    const saved = saveSourceRecord(db, "c", {
      externalId: "rival",
      title: "rival",
      body: `rival says ${RIVAL}`,
    });
    if (saved.status !== "created") throw new Error("expected a new version");
    addEvidence(db, {
      target: { factId: rival },
      sourceVersionId: db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number,
      start: "rival says ".length,
      end: "rival says ".length + RIVAL.length,
      quote: RIVAL,
    });
    expect(assessAutoVerify(db, { kind: "fact", id }, T).status).toBe("applied"); // reverted
    expect(status(id)).toBe("candidate");
    // the split moves the rival away: the same request promotes `id` again
    const res = await post("entitySplit", {
      itemId: item,
      rows: [{ kind: "fact", id: rival }],
      name: "rival item",
    });
    expect(res.body).toMatchObject({ status: "applied" });
    expect(status(id)).toBe("verified");
    expect(actions(id).at(-1)).toBe("policy:auto-verify");
  });
});
