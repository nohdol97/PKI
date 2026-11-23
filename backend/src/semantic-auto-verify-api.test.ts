// S01-T05 rework (review M2): the judgement runs after the user's actions over HTTP, in the action's own
// transaction (`judgeAgain` in server.ts). A value the user writes or approves is valid under R15, so a
// promoted sibling goes back; an undo can give a row back to the policy while its grounds are gone.
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
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

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
const post = (name: "semanticDecide" | "semanticUndo" | "semanticCorrect", body: unknown) =>
  send(server.port, routes[name].path, headers, "POST", body);

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
