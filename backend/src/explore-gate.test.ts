// X02-C2b (R4, negative test): the three Explore reads under a policy that refuses one scope and a source that
// was deleted. A hidden item leaves no trace in the answers or the log; asked for by number it is the same
// 404 as a number nothing is stored under; it takes no slot of a page and moves no `next`. All data is synthetic.
// Mutation checks of this file (the list's item check removed, the centre's item check removed) are in the PR.
import { routes, type RouteName } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
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
  type SqlDriver,
} from "@pki/storage";
import { dirTemplate, seedLegacyTombstone, send } from "@pki/testkit";
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
const NOT_FOUND = { status: 404, body: { error: "not-found" } };
const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-23T00:00:00Z",
} as const;
/** A policy that refuses a scope naming "secret". */
const hidingSecret = (): DerivativeRegistry =>
  createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
    policy: {
      ...defaultScopePolicy,
      allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
    },
  });

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;
let logged: string[];
let spies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-explore-gate-"));
  seedDataDir(dir);
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
  logged = [];
  spies = (["error", "warn", "log", "info", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    }),
  );
});
afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
async function start() {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: ["http://localhost:5173"],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    decisions: userDecisions,
    registry: hidingSecret(),
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
}
const call = (name: RouteName, body?: unknown) =>
  send((server as RunningServer).port, routes[name].path, valid, routes[name].method, body);

let counter = 0;
/** A source and the id of its version; `scope` is what the source is restricted to. */
function source(body: string, scope: string[] | null) {
  const externalId = `s${++counter}`;
  const saved = saveSourceRecord(db, "c", {
    externalId,
    title: `제목 ${body}`,
    body,
    accessScope: scope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { versionId, sourceId: saved.sourceId };
}
/** An item with one fact citing `versionId`: the item is shown exactly when that version is. */
function item(name: string, versionId: number, value = "공개 값") {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  const factId = saveFact(db, { itemId: id, kind: "memo", value, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "fact", id: factId }, "extraction", null);
  addEvidence(db, {
    target: { factId },
    sourceVersionId: versionId,
    start: 0,
    end: 2,
    quote: "본문",
  });
  return id;
}
function relation(subject: number, object: number, versionId: number) {
  const id = saveRelation(db, {
    subjectId: subject,
    type: "DEPENDS_ON",
    objectId: object,
    ...attrs,
  }).id;
  automatedLifecycle.created(db, { kind: "relation", id }, "extraction", null);
  addEvidence(db, {
    target: { relationId: id },
    sourceVersionId: versionId,
    start: 0,
    end: 2,
    quote: "본문",
  });
}
const CANARY_DENIED = "카나리비밀";
const CANARY_DELETED = "카나리삭제";

describe("explore.gate (X02-C2b)", () => {
  it("leaves a policy-hidden item and an item of a deleted source out of every answer and the log, and answers them by number as a missing number", async () => {
    const open = source("본문 공개", null);
    const secret = source("본문 비밀", ["secret"]);
    const gone = source("본문 삭제", null);
    const shownA = item("보이는 A", open.versionId);
    const shownB = item("보이는 B", open.versionId);
    const denied = item(CANARY_DENIED, secret.versionId, `${CANARY_DENIED} 값`);
    const deleted = item(CANARY_DELETED, gone.versionId, `${CANARY_DELETED} 값`);
    relation(shownA, shownB, open.versionId);
    // the relations rest on the open source: only the far item's own facts are hidden, so the edge is dropped by its end
    relation(shownA, denied, open.versionId);
    relation(shownA, deleted, open.versionId);
    // a cover whose purge never ran: only the gate keeps the version out
    seedLegacyTombstone(db, {
      sourceId: gone.sourceId,
      version: 1,
      at: "2026-11-23T00:00:00.000Z",
      reason: "user-deleted",
    });
    await start();

    const list = await call("exploreItems", {});
    const centre = await call("exploreItem", { itemId: shownA, depth: 2 });
    const text = await call("exploreSource", { versionId: open.versionId });
    expect(routes.exploreItems.response.parse(list.body).items.map((i) => i.id)).toEqual([
      shownA,
      shownB,
    ]);
    const hiddenNeighbour = routes.exploreItem.response.parse(centre.body);
    expect(hiddenNeighbour.items?.map((i) => i.id)).toEqual([shownB]);
    expect(hiddenNeighbour.edges?.map((e) => e.to)).toEqual([shownB]);
    const seen = JSON.stringify([list.body, centre.body, text.body, logged]);
    for (const canary of [CANARY_DENIED, CANARY_DELETED]) expect(seen).not.toContain(canary);
    for (const hidden of [denied, deleted]) {
      expect(seen).not.toMatch(
        new RegExp(`"(id|to|from|itemId|subjectId|objectId)":${hidden}[,}]`),
      );
      expect(await call("exploreItem", { itemId: hidden, depth: 1 })).toEqual(NOT_FOUND);
    }
    expect(await call("exploreItem", { itemId: 99_999, depth: 1 })).toEqual(NOT_FOUND);
    // a version of a hidden source (R4 4) is the missing number's 404, too
    for (const v of [secret.versionId, gone.versionId, 99_999]) {
      expect(await call("exploreSource", { versionId: v })).toEqual(NOT_FOUND);
    }
  });

  it("gives the first page 50 items with the hidden ones between them, in the order and with the `next` of a store without them", async () => {
    const open = source("본문 공개", null);
    const secret = source("본문 비밀", ["secret"]);
    const visible: number[] = [];
    for (let i = 0; i < 60; i++) {
      visible.push(item(`보임 ${i}`, open.versionId));
      if (i % 3 === 0) item(`${CANARY_DENIED} ${i}`, secret.versionId);
    }
    await start();
    const first = routes.exploreItems.response.parse((await call("exploreItems", {})).body);
    expect(first.items.map((i) => i.id)).toEqual(visible.slice(0, 50));
    expect(first.next).toBe(visible[49]);
    const second = routes.exploreItems.response.parse(
      (await call("exploreItems", { after: first.next })).body,
    );
    expect(second.items.map((i) => i.id)).toEqual(visible.slice(50));
    expect(second.next).toBeNull();
    expect(JSON.stringify([first, second])).not.toContain(CANARY_DENIED);
  });
});
