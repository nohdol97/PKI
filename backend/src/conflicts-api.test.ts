// S02-T08 `time.valid-observed` and `conflicts.permission-crossing` over HTTP (S02-R17, R24 1, R25): the user's fix of a
// valid interval (`POST /api/semantic/validity`) and the conflict list (`GET /api/conflicts`). A row the policy hides is
// the one `not-found`; the list leaves out a link with a hidden side and computes a fact's effective end from the links it
// shows only, so nothing tells what was left out. All data is synthetic.
import { routes, type RouteName } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
import {
  addEvidence,
  automatedLifecycle,
  createDerivativeRegistry,
  defaultScopePolicy,
  insertAssertionLink,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  userDecisions,
  type DerivativeRegistry,
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
const AT = "2026-11-23T00:00:00.000Z";
const NOT_FOUND = { status: 404, body: { error: "not-found" } };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-conflicts-api-"));
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

let counter = 0;
const item = () => {
  const id = insertItem(db, { type: "Project", name: `p${++counter}`, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  return id;
};
/** A target_date fact with its source's evidence; `accessScope` is what the source is restricted to. */
function fact(
  itemId: number,
  value: string,
  own: { from?: string; until?: string; accessScope?: string[] | null } = {},
) {
  const saved = saveSourceRecord(db, "c", {
    externalId: `s${++counter}`,
    title: "t",
    body: "body text",
    accessScope: own.accessScope ?? null,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const id = saveFact(db, {
    itemId,
    kind: "target_date",
    value,
    validUntil: own.until ?? null,
    ...attrs,
    validAt: own.from ?? null,
  }).id;
  automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null);
  addEvidence(db, {
    target: { factId: id },
    sourceVersionId: db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number,
    start: 0,
    end: 4,
    quote: "body",
  });
  return id;
}
const link = (type: "SUPERSEDES" | "CONTRADICTS", from: number, to: number) =>
  insertAssertionLink(db, { type, fromFactId: from, toFactId: to, createdBy: "rule", at: AT }).id;
const hidingSecret = () =>
  createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
    policy: {
      ...defaultScopePolicy,
      allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
    },
  });

describe("POST /api/semantic/validity (S02-R17)", () => {
  it("fixes the interval and returns the previous one; a hidden row is not-found; an unreal date or from >= until is bad-request", async () => {
    const owner = item();
    const open = fact(owner, "2026-12-01", { from: "2026-01-01" });
    const hidden = fact(owner, "2026-12-02", { accessScope: ["secret"] });
    await start({ registry: hidingSecret() });
    const ok = await call("semanticValidity", {
      kind: "fact",
      id: open,
      from: "2026-02-01",
      until: "2026-03-01",
    });
    expect(ok).toEqual({
      status: 200,
      body: {
        status: "applied",
        seq: expect.any(Number),
        previous: { from: "2026-01-01", until: null },
      },
    });
    expect(
      db.all("SELECT valid_at, valid_until, observed_at FROM facts WHERE id = ?", [open]),
    ).toEqual([
      { valid_at: "2026-02-01", valid_until: "2026-03-01", observed_at: attrs.observedAt },
    ]);
    expect(
      await call("semanticValidity", { kind: "fact", id: hidden, from: null, until: null }),
    ).toEqual(NOT_FOUND);
    expect(
      await call("semanticValidity", { kind: "fact", id: 99_999, from: null, until: null }),
    ).toEqual(NOT_FOUND);
    for (const [from, until] of [
      ["2026-02-30", null],
      ["2026-03-01", "2026-03-01"],
    ]) {
      expect(await call("semanticValidity", { kind: "fact", id: open, from, until })).toEqual({
        status: 400,
        body: { error: "bad-request" },
      });
    }
  });
});

describe("GET /api/conflicts (S02-R25)", () => {
  it("lists type, the two facts, who made the link and the effective end", async () => {
    const owner = item();
    const early = fact(owner, "2026-12-01", { from: "2026-01-01" });
    const late = fact(owner, "2026-12-02", { from: "2026-06-01" });
    const id = link("SUPERSEDES", late, early);
    await start();
    expect(await call("conflicts")).toEqual({
      status: 200,
      body: {
        links: [
          {
            id,
            type: "SUPERSEDES",
            createdBy: "rule",
            from: { factId: late, itemId: owner, effectiveUntil: null },
            to: { factId: early, itemId: owner, effectiveUntil: "2026-06-01" },
          },
        ],
        truncated: false,
      },
    });
  });

  it("conflicts.permission-crossing: a link with a side the policy hides is absent, the visible fact's effective end carries no date of a hidden superseder, and the answer equals the one with no such link at all", async () => {
    const owner = item();
    const a = fact(owner, "2026-12-01", { from: "2026-01-01", until: "2026-12-31" });
    const c = fact(owner, "2026-12-03", { from: "2026-02-01", until: "2026-12-31" });
    const hidden = fact(owner, "2026-12-02", { from: "2026-06-01", accessScope: ["secret"] });
    link("CONTRADICTS", a, c);
    const crossing = link("SUPERSEDES", hidden, a);
    await start({ registry: hidingSecret() });
    const withHidden = await call("conflicts");
    expect(withHidden.status).toBe(200);
    const body = withHidden.body as { links: { from: { factId: number } }[] };
    expect(body.links).toHaveLength(1);
    expect(JSON.stringify(withHidden.body)).not.toContain("2026-06-01");
    db.run("DELETE FROM assertion_links WHERE id = ?", [crossing]);
    db.run("DELETE FROM facts WHERE id = ?", [hidden]);
    expect(await call("conflicts")).toEqual(withHidden);
  });
});
