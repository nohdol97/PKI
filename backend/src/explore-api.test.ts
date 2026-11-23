// X02-C2a (R1..R3): the Explore screen's three reads over HTTP on a booted backend, with synthetic data. A name
// search and its paging, one item's neighbourhood with the valid interval and the depth refusal, and a source
// version read by its version id. The hidden-row cases are in explore-gate.test.ts.
import { routes, type RouteName } from "@pki/contracts";
import {
  addEvidence,
  automatedLifecycle,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  userDecisions,
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
const TOKEN = "s".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-23T00:00:00Z",
} as const;

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-explore-api-"));
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
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
}
const call = (name: RouteName, body?: unknown) =>
  send((server as RunningServer).port, routes[name].path, valid, routes[name].method, body);

const item = (name: string, type = "Project") => {
  const id = insertItem(db, { type, name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  return id;
};
/** A stored source and the id of its only version. */
function source(body: string, title = "제목") {
  const saved = saveSourceRecord(db, "c", {
    externalId: `s-${body}`,
    title,
    body,
    accessScope: null,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}
const cite = (target: { factId: number } | { relationId: number }, versionId: number) =>
  addEvidence(db, { target, sourceVersionId: versionId, start: 0, end: 2, quote: "본문" });
function fact(itemId: number, value: string, versionId: number, validAt: string | null = null) {
  const id = saveFact(db, { itemId, kind: "memo", value, ...attrs, validAt }).id;
  automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null);
  cite({ factId: id }, versionId);
  return id;
}
function relation(subject: number, object: number, versionId: number) {
  const id = saveRelation(db, { subjectId: subject, type: "DEPENDS_ON", objectId: object, ...attrs })
    .id;
  automatedLifecycle.created(db, { kind: "relation", id }, "extraction", null);
  cite({ relationId: id }, versionId);
  return id;
}

describe("explore.api (X02-C2a)", () => {
  it("finds an item by part of its name and pages 50 at a time without overlap", async () => {
    const ids = Array.from({ length: 55 }, (_, i) => item(`묶음-${i}`));
    item("다른 이름");
    await start();
    const found = await call("exploreItems", { query: "다른" });
    expect(routes.exploreItems.response.parse(found.body).items.map((i) => i.name)).toEqual([
      "다른 이름",
    ]);
    const first = routes.exploreItems.response.parse((await call("exploreItems", {})).body);
    expect(first.items).toHaveLength(50);
    expect(first.next).toBe(first.items[49]?.id);
    const second = routes.exploreItems.response.parse(
      (await call("exploreItems", { after: first.next })).body,
    );
    expect(second.items.length).toBe(6);
    expect(second.next).toBeNull();
    const all = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(all).size).toBe(56);
    expect(all.slice(0, 55)).toEqual(ids);
  });

  it("reads the neighbours at depth 1 with their names, the valid start of a fact, and refuses depth 4", async () => {
    const a = item("미리내");
    const b = item("물결");
    const c = item("먼 항목");
    const v = source("본문 하나");
    fact(a, "값", v, "2026-01-01");
    relation(a, b, v);
    relation(b, c, v);
    await start();
    const res = await call("exploreItem", { itemId: a, depth: 1 });
    expect(res.status).toBe(200);
    const body = routes.exploreItem.response.parse(res.body);
    expect(body.center).toMatchObject({ id: a, name: "미리내" });
    expect(body.center?.facts[0]).toMatchObject({ validAt: "2026-01-01", validUntil: null });
    expect(body.items?.map((i) => i.name)).toEqual(["물결"]);
    expect(body.edges).toEqual([
      expect.objectContaining({ type: "DEPENDS_ON", direction: "forward", from: a, to: b, step: 1 }),
    ]);
    const deeper = routes.exploreItem.response.parse(
      (await call("exploreItem", { itemId: a, depth: 2 })).body,
    );
    expect(deeper.items?.map((i) => i.name)).toEqual(["물결", "먼 항목"]);
    expect(await call("exploreItem", { itemId: a, depth: 4 })).toEqual({
      status: 200,
      body: { status: "refused", reason: "depth-exceeded" },
    });
  });

  it("reads a source version by its version id with the stored body", async () => {
    const v = source("저장된 본문입니다", "원본 제목");
    await start();
    const res = await call("exploreSource", { versionId: v });
    expect(routes.exploreSource.response.parse(res.body).sourceVersion).toEqual({
      id: v,
      version: 1,
      latestVersion: 1,
      title: "원본 제목",
      body: "저장된 본문입니다",
    });
    expect(await call("exploreSource", { versionId: v + 1000 })).toEqual({
      status: 404,
      body: { error: "not-found" },
    });
  });
});
