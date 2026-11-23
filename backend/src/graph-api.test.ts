// S02-T09 `graph.api` over HTTP (S02-R25, decision 31): `POST /api/graph/trace` and `POST /api/graph/paths`. The answers
// are numbers and codes that fit the contract and hold no name; a depth past the limit is a refusal code in a 200 body; an
// absent item and one the policy hides are the one `not-found`. All data is synthetic.
import { routes, type RouteName } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
import {
  addEvidence,
  automatedLifecycle,
  createDerivativeRegistry,
  defaultScopePolicy,
  insertItem,
  registerConnectorInstance,
  saveRelation,
  saveSourceRecord,
  userDecisions,
  type DerivativeRegistry,
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
const NAMES = ["Zorbax", "Quillon", "Mervane"];

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-graph-api-"));
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

async function start(options: { registry?: DerivativeRegistry } = {}) {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    decisions: userDecisions,
    ...(options.registry ? { registry: options.registry } : {}),
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
const item = (name: string) => {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  return id;
};
let counter = 0;
/** A relation with its source's evidence; `accessScope` is what the source is restricted to. */
function relation(subject: number, object: number, accessScope: string[] | null = null) {
  const saved = saveSourceRecord(db, "c", {
    externalId: `s${++counter}`,
    title: "t",
    body: "body text",
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const id = saveRelation(db, {
    subjectId: subject,
    type: "DEPENDS_ON",
    objectId: object,
    ...attrs,
  }).id;
  automatedLifecycle.created(db, { kind: "relation", id }, "extraction", null);
  addEvidence(db, {
    target: { relationId: id },
    sourceVersionId: db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number,
    start: 0,
    end: 4,
    quote: "body",
  });
  return id;
}
const hidingSecret = () =>
  createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
    policy: {
      ...defaultScopePolicy,
      allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
    },
  });

describe("graph.api (S02-R25)", () => {
  it("both routes answer the contract and carry no name", async () => {
    const [a, b, c] = NAMES.map(item) as [number, number, number];
    relation(a, b);
    relation(b, c);
    await start();
    const paths = await call("graphPaths", { from: a, depth: 2 });
    expect(paths.status).toBe(200);
    const parsed = routes.graphPaths.response.parse(paths.body);
    expect(parsed).toMatchObject({ status: "ok", truncated: false });
    expect(parsed.paths?.map((p) => p.length)).toEqual([1, 2]);
    const trace = await call("graphTrace", { kind: "item", id: a });
    expect(trace.status).toBe(200);
    const chains = routes.graphTrace.response.parse(trace.body).chains;
    expect(chains[0]?.map((h) => h.edge)).toEqual(["HAS", "SUPPORTS", "MENTIONS"]);
    for (const name of NAMES) {
      expect(JSON.stringify(paths.body)).not.toContain(name);
      expect(JSON.stringify(trace.body)).not.toContain(name);
    }
  });

  it("a refusal is a code in a 200 body; an absent id and a hidden one are the same not-found", async () => {
    const a = item(NAMES[0] as string);
    const hidden = item(NAMES[1] as string);
    relation(hidden, a, ["secret"]);
    await start({ registry: hidingSecret() });
    expect(await call("graphPaths", { from: a, depth: 4 })).toEqual({
      status: 200,
      body: { status: "refused", reason: "depth-exceeded" },
    });
    for (const id of [hidden, 99_999]) {
      expect(await call("graphPaths", { from: id, depth: 1 })).toEqual(NOT_FOUND);
      expect(await call("graphTrace", { kind: "item", id })).toEqual(NOT_FOUND);
    }
    expect(JSON.stringify(NOT_FOUND)).not.toContain(NAMES[1] as string);
  });
});
