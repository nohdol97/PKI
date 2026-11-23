// X02B-C1 (R1..R5): the Explore and Semantic review reads that X02B adds or widens, over HTTP on a booted backend
// with synthetic data. The hidden-row cases are in curation-gate.test.ts.
import { routes, type RouteName } from "@pki/contracts";
import {
  addEvidence,
  automatedLifecycle,
  insertItem,
  insertProviderCall,
  registerConnectorInstance,
  saveFact,
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
  status: "verified",
  validAt: null,
  observedAt: "2026-11-24T00:00:00Z",
} as const;

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-curation-api-"));
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
const fact = (
  itemId: number,
  kind: string,
  value: string,
  status: "verified" | "candidate" | "rejected",
) => {
  const id = saveFact(db, { itemId, kind, value, ...attrs, status }).id;
  automatedLifecycle.created(db, { kind: "fact", id }, "extraction", null);
  return id;
};
let counter = 0;
function source(body: string, extra: Record<string, unknown> = {}) {
  const saved = saveSourceRecord(db, "c", {
    externalId: `s${++counter}`,
    title: `제목 ${counter}`,
    body,
    accessScope: null,
    ...extra,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}

describe("curation.api (X02B-C1)", () => {
  it("finds an item by an alias and says which alias; a name match carries a null alias", async () => {
    const wave = item("물결");
    fact(wave, "alias.synonym", "파도타기", "verified");
    fact(item("먼 항목"), "alias.synonym", "기각된별칭", "rejected");
    await start();
    const byAlias = routes.exploreItems.response.parse(
      (await call("exploreItems", { query: "파도" })).body,
    );
    expect(byAlias.items).toEqual([{ id: wave, type: "Project", name: "물결", alias: "파도타기" }]);
    const byName = routes.exploreItems.response.parse(
      (await call("exploreItems", { query: "물결" })).body,
    );
    expect(byName.items).toEqual([{ id: wave, type: "Project", name: "물결", alias: null }]);
    expect(
      routes.exploreItems.response.parse((await call("exploreItems", { query: "기각된" })).body)
        .items,
    ).toEqual([]);
  });

  it("filters the review list by status on the server past the first 100 items, and pages without overlap", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => item(`항목 ${String(i).padStart(3, "0")}`));
    for (const id of ids) fact(id, "memo", `값 ${id}`, "verified");
    const late = ids[114] as number;
    fact(late, "memo", "후보 값", "candidate");
    await start();
    const candidates = routes.semanticPage.response.parse(
      (await call("semanticPage", { status: "candidate" })).body,
    );
    expect(candidates.items.map((i) => i.id)).toEqual([late]);
    expect(candidates.next).toBeNull();
    const first = routes.semanticPage.response.parse((await call("semanticPage", {})).body);
    expect(first.items).toHaveLength(50);
    expect(first.next).toBe(first.items[49]?.id);
    const second = routes.semanticPage.response.parse(
      (await call("semanticPage", { after: first.next })).body,
    );
    expect(second.items.length).toBe(50);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(100);
  });

  it("lists a merged item as a member with its merge line, and names two items and skips a missing number", async () => {
    const rep = item("대표");
    const member = item("구성원");
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, ?)",
      [member, rep, "2026-11-24T00:00:00Z"],
    );
    const mergeId = db.all("SELECT id FROM item_merges")[0]?.id as number;
    await start();
    const centre = routes.exploreItem.response.parse(
      (await call("exploreItem", { itemId: rep, depth: 1 })).body,
    );
    expect(centre.center?.members).toEqual([
      { id: member, type: "Project", name: "구성원", mergeId },
    ]);
    const names = routes.exploreNames.response.parse(
      (await call("exploreNames", { ids: [rep, member, 99_999] })).body,
    );
    expect(names.items.map((i) => [i.id, i.name])).toEqual([
      [rep, "대표"],
      [member, "구성원"],
    ]);
  });

  it("pages the source list and the provider-call list 50 at a time, newest first, without overlap", async () => {
    const versions = Array.from({ length: 55 }, (_, i) => source(`본문 ${i}`));
    for (let i = 0; i < 55; i++) {
      insertProviderCall(db, {
        requestId: `r${i}`,
        attempt: 1,
        provider: "local-test",
        destination: "local",
        taskKind: "extract",
        classification: "public",
        policyVersion: "p1",
        outcome: "succeeded",
        reason: null,
        durationMs: 1,
        createdAt: "2026-11-24T00:00:00.000Z",
      });
    }
    await start();
    const newest = [...versions].reverse();
    const s1 = routes.sourcesPage.response.parse((await call("sourcesPage", {})).body);
    expect(s1.sources.map((s) => s.id)).toEqual(newest.slice(0, 50));
    expect(s1.next).toBe(newest[49]);
    const s2 = routes.sourcesPage.response.parse(
      (await call("sourcesPage", { before: s1.next })).body,
    );
    expect(s2.sources.map((s) => s.id)).toEqual(newest.slice(50));
    expect(s2.next).toBeNull();
    const a1 = routes.activityPage.response.parse((await call("activityPage", {})).body);
    expect(a1.calls.map((c) => c.requestId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `r${54 - i}`),
    );
    expect(a1.next).not.toBeNull();
    const a2 = routes.activityPage.response.parse(
      (await call("activityPage", { before: a1.next })).body,
    );
    expect(a2.calls.map((c) => c.requestId)).toEqual(["r4", "r3", "r2", "r1", "r0"]);
    expect(a2.next).toBeNull();
  });

  it("reads a cited source with the attachment and locator at `start`, and with null for both without it", async () => {
    const v = source("합성 등대 본문", {
      provenance: { attachments: [{ name: "보고서.pdf", mediaType: "application/pdf", size: 7 }] },
      blocks: [{ start: 0, end: 4, attachment: 0, locator: { format: "pdf", page: 3 } }],
    });
    addEvidence(db, {
      target: { factId: fact(item("인용"), "memo", "값", "verified") },
      sourceVersionId: v,
      start: 0,
      end: 2,
      quote: "합성",
    });
    await start();
    const at = routes.exploreSource.response.parse(
      (await call("exploreSource", { versionId: v, start: 1 })).body,
    );
    expect(at.locator).toEqual({ format: "pdf", page: 3 });
    expect(at.attachment).toMatchObject({ name: "보고서.pdf" });
    const without = routes.exploreSource.response.parse(
      (await call("exploreSource", { versionId: v })).body,
    );
    expect([without.locator, without.attachment]).toEqual([null, null]);
  });
});
