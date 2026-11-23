// X02B-C2 (R6, negative test): the reads X02B adds or widens under a policy that refuses one scope and a source that
// was deleted. A hidden alias, status row, member, source or version leaves no trace in an answer or the log, takes no
// slot of a page and moves no `next`. All data is synthetic.
// Mutation checks of this file (the alias fact's visibility check removed, the status row's visibility check
// removed) are in the PR.
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
  observedAt: "2026-11-24T00:00:00Z",
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
  dir = mkdtempSync(join(tmpdir(), "pki-curation-gate-"));
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
function source(body: string, scope: string[] | null) {
  const saved = saveSourceRecord(db, "c", {
    externalId: `s${++counter}`,
    title: `제목 ${body}`,
    body,
    accessScope: scope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { versionId, sourceId: saved.sourceId };
}
/** An item the user wrote: no lineage of its own, so it stays shown while a fact citing a hidden version does not. */
function userItem(name: string) {
  const added = userDecisions.add(db, { kind: "item", type: "Project", name });
  if (added.status !== "applied") throw new Error("the user's item");
  db.run("UPDATE items SET status = 'verified' WHERE id = ?", [added.ref.id]);
  return added.ref.id;
}
/** An extracted item with one fact citing `versionId`: the item is shown exactly when that version is. */
function item(name: string, versionId: number) {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  fact(id, "memo", `${name} 값`, versionId);
  return id;
}
function fact(itemId: number, kind: string, value: string, versionId: number) {
  const id = saveFact(db, { itemId, kind, value, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null);
  addEvidence(db, {
    target: { factId: id },
    sourceVersionId: versionId,
    start: 0,
    end: 2,
    quote: "본문",
  });
  return id;
}
const CANARY_DENIED = "카나리비밀";
const CANARY_DELETED = "카나리삭제";

describe("curation.gate (X02B-C2)", () => {
  it("leaves a hidden alias out of the search and the `alias` column", async () => {
    const open = source("본문 공개", null);
    const secret = source("본문 비밀", ["secret"]);
    const gone = source("본문 삭제", null);
    const shown = userItem("보이는 항목");
    fact(shown, "alias.synonym", "공개별칭", open.versionId);
    fact(shown, "alias.synonym", `${CANARY_DENIED}별칭`, secret.versionId);
    fact(shown, "alias.synonym", `${CANARY_DELETED}별칭`, gone.versionId);
    seedLegacyTombstone(db, {
      sourceId: gone.sourceId,
      version: 1,
      at: "2026-11-24T00:00:00.000Z",
      reason: "user-deleted",
    });
    await start();
    const seen: unknown[] = [];
    for (const canary of [CANARY_DENIED, CANARY_DELETED]) {
      const res = await call("exploreItems", { query: canary });
      seen.push(res.body);
      expect(routes.exploreItems.response.parse(res.body).items).toEqual([]);
    }
    const open_ = await call("exploreItems", { query: "별칭" });
    seen.push(open_.body);
    expect(routes.exploreItems.response.parse(open_.body).items).toEqual([
      { id: shown, type: "Project", name: "보이는 항목", alias: "공개별칭" },
    ]);
    const text = JSON.stringify([seen, logged]);
    for (const canary of [CANARY_DENIED, CANARY_DELETED]) expect(text).not.toContain(canary);
  });

  it("keeps an item whose rows of a status are all hidden out of that status's list, and keeps page size, order and `next` as without the hidden ones", async () => {
    const open = source("본문 공개", null);
    const secret = source("본문 비밀", ["secret"]);
    // shown, but its only candidate fact cites the secret version
    const quiet = userItem("후보 없음처럼");
    fact(quiet, "memo", `${CANARY_DENIED} 값`, secret.versionId);
    const visible: number[] = [];
    for (let i = 0; i < 60; i++) {
      visible.push(item(`보임 ${i}`, open.versionId));
      if (i % 3 === 0) item(`${CANARY_DENIED} ${i}`, secret.versionId);
    }
    await start();
    const first = routes.semanticPage.response.parse(
      (await call("semanticPage", { status: "candidate" })).body,
    );
    expect(first.items.map((i) => i.id)).toEqual(visible.slice(0, 50));
    expect(first.next).toBe(visible[49]);
    const second = routes.semanticPage.response.parse(
      (await call("semanticPage", { status: "candidate", after: first.next })).body,
    );
    expect(second.items.map((i) => i.id)).toEqual(visible.slice(50));
    expect(second.next).toBeNull();
    expect(JSON.stringify([first, second, logged])).not.toContain(CANARY_DENIED);
  });

  it("leaves a hidden member out of `members` and answers a hidden number of `exploreNames` as a missing one", async () => {
    const open = source("본문 공개", null);
    const secret = source("본문 비밀", ["secret"]);
    const rep = userItem("대표");
    const shownMember = item("보이는 구성원", open.versionId);
    const hiddenMember = item(CANARY_DENIED, secret.versionId);
    for (const m of [shownMember, hiddenMember]) {
      db.run("INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, ?)", [
        m,
        rep,
        "2026-11-24T00:00:00Z",
      ]);
    }
    const hiddenLine = db.all("SELECT id FROM item_merges WHERE member_id = ?", [
      hiddenMember,
    ])[0]?.id as number;
    await start();
    const centre = await call("exploreItem", { itemId: rep, depth: 1 });
    expect(
      routes.exploreItem.response.parse(centre.body).center?.members.map((m) => m.id),
    ).toEqual([shownMember]);
    const names = await call("exploreNames", { ids: [hiddenMember] });
    expect(names).toEqual(await call("exploreNames", { ids: [99_999] }));
    expect(names.body).toEqual({ items: [] });
    const text = JSON.stringify([centre.body, names.body, logged]);
    expect(text).not.toContain(CANARY_DENIED);
    expect(text).not.toMatch(new RegExp(`"(id|mergeId)":(${hiddenMember}|${hiddenLine})[,}]`));
  });

  it("keeps size, order and `next` of the source page with hidden sources between, and answers a hidden version as a missing one", async () => {
    const secret = source("본문 비밀", ["secret"]);
    const visible: number[] = [];
    for (let i = 0; i < 55; i++) {
      visible.push(source(`본문 ${i}`, null).versionId);
      if (i % 4 === 0) source(`${CANARY_DENIED} ${i}`, ["secret"]);
    }
    const newest = visible.reverse();
    await start();
    const first = routes.sourcesPage.response.parse((await call("sourcesPage", {})).body);
    expect(first.sources.map((s) => s.id)).toEqual(newest.slice(0, 50));
    expect(first.next).toBe(newest[49]);
    const second = routes.sourcesPage.response.parse(
      (await call("sourcesPage", { before: first.next })).body,
    );
    expect(second.sources.map((s) => s.id)).toEqual(newest.slice(50));
    expect(second.next).toBeNull();
    expect(JSON.stringify([first, second, logged])).not.toContain(CANARY_DENIED);
    expect(await call("exploreSource", { versionId: secret.versionId, start: 0 })).toEqual(
      NOT_FOUND,
    );
  });
});
