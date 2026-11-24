// DPF-C1 (R1, R2): `POST /api/entities/distinct/marks` lists the "not the same" marks on one item. A mark whose other
// item is hidden leaves no trace; a hidden or absent item asked about is the one same 404. All data is synthetic.
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
  saveSourceRecord,
  userDecisions,
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
const TOKEN = "s".repeat(43);
const ORIGIN = "http://localhost:5173";
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const NOT_FOUND = { status: 404, body: { error: "not-found" } };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-distinct-marks-"));
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
  const registry = createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
    policy: {
      ...defaultScopePolicy,
      allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
    },
  });
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    decisions: userDecisions,
    registry,
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

/** An item a source built: its lineage is that source's, whose scope the policy reads. */
function itemFrom(externalId: string, accessScope: string[] | null = null) {
  const saved = saveSourceRecord(db, "c", {
    externalId,
    title: `제목 ${externalId}`,
    body: "합성 본문",
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const item = insertItem(db, { type: "Project", name: `프로젝트 ${externalId}`, ...attrs });
  const fact = saveFact(db, {
    itemId: item,
    kind: "target_date",
    value: "2026-12-05",
    ...attrs,
  }).id;
  automatedLifecycle.created(db, { kind: "item", id: item }, "extraction", {
    sourceId: saved.sourceId,
    version: saved.version,
  });
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number,
    start: 0,
    end: 2,
    quote: "합성",
  });
  return item;
}

describe("POST /api/entities/distinct/marks (DPF-R1, R2)", () => {
  it("lists the shown marks of an item and leaves no trace of a hidden other item", async () => {
    const a = itemFrom("a");
    const b = itemFrom("b");
    const hidden = itemFrom("hidden", ["secret"]);
    await start();
    expect((await call("entityDistinct", { a, b, on: true })).status).toBe(200);
    db.run("INSERT INTO item_distinct (item_a, item_b, by, at) VALUES (?, ?, 'user', ?)", [
      a,
      hidden,
      "2026-11-24T00:00:00Z",
    ]);
    const res = await call("entityDistinctMarks", { itemId: a });
    expect(res.status).toBe(200);
    const body = routes.entityDistinctMarks.response.parse(res.body);
    expect(body).toEqual({
      marks: [{ id: b, type: "Project", name: "프로젝트 b", by: "user", at: expect.any(String) }],
      truncated: false,
    });
    // the same answer as when the hidden pair was never marked
    db.run("DELETE FROM item_distinct WHERE item_b = ?", [hidden]);
    expect((await call("entityDistinctMarks", { itemId: a })).body).toEqual(res.body);
  });

  it("answers the one same 404 for a hidden item and a number that is not stored", async () => {
    const hidden = itemFrom("hidden", ["secret"]);
    await start();
    expect(await call("entityDistinctMarks", { itemId: hidden })).toEqual(NOT_FOUND);
    expect(await call("entityDistinctMarks", { itemId: 99_999 })).toEqual(NOT_FOUND);
  });

  it("leaves out a mark whose other item sits under a hidden group top, which the clear route would refuse", async () => {
    const a = itemFrom("a");
    const member = itemFrom("member");
    const hiddenTop = itemFrom("top", ["secret"]);
    db.run("INSERT INTO item_distinct (item_a, item_b, by, at) VALUES (?, ?, 'user', ?)", [
      a,
      member,
      "2026-11-24T00:00:00Z",
    ]);
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, ?)",
      [member, hiddenTop, "2026-11-24T00:00:00Z"],
    );
    await start();
    expect((await call("entityDistinctMarks", { itemId: a })).body).toEqual({
      marks: [],
      truncated: false,
    });
  });
});
