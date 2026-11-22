// I04-T08 (composition wiring): the registry boot builds reaches every read path R13 names. A registry
// that hides everything is injected into `bootBackend`; each route must then answer as if nothing were
// stored (an empty list, or not-found), and must have asked the registry about the kind it shows.
// Dropping the registry argument on one path leaves it on the default registry, which shows the row,
// and that path's test red.
import { routes } from "@pki/contracts";
import { NO_POLICY_YET, createProductRegistry } from "@pki/knowledge-engine";
import {
  addEvidence,
  createDerivativeRegistry,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveSourceRecord,
  type DerivativeRegistry,
  type DerivedRef,
} from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "g".repeat(43);

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-read-gate-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** The product's registry whose `visible` hides everything and notes the kinds it was asked about. */
function hiding() {
  const asked: string[] = [];
  const base = createDerivativeRegistry({
    kinds: createProductRegistry({ policy: NO_POLICY_YET }).kinds,
    policy: { ...NO_POLICY_YET, allows: () => true },
  });
  const registry: DerivativeRegistry = {
    ...base,
    visible: (_db, refs: readonly DerivedRef[]) => {
      asked.push(...refs.map((r) => r.kind));
      return [];
    },
  };
  return { asked, registry };
}

async function boot(registry?: DerivativeRegistry) {
  booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    ...(registry ? { registry } : {}),
  });
  const { db, server } = booted;
  const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  registerConnectorInstance(db, "c", "test-fixtures");
  const saved = saveSourceRecord(db, "c", { externalId: "s", title: "제목 s", body: "합성 등대" });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const attrs = {
    epistemic: "explicit",
    status: "candidate",
    validAt: null,
    observedAt: "2026-11-22T00:00:00Z",
  } as const;
  const x = insertItem(db, { ...attrs, type: "Project", name: "X" });
  const y = insertItem(db, { ...attrs, type: "System", name: "Y" });
  const fact = saveFact(db, { ...attrs, itemId: x, kind: "target_date", value: "2026-12-05" });
  const evidenceId = addEvidence(db, {
    target: { factId: fact.id },
    sourceVersionId: versionId,
    start: 0,
    end: 2,
    quote: "합성",
  });
  saveInsight(
    db,
    { rule: "dependency_delay", xItemId: x, yItemId: y },
    { state: "active", summary: "요약", evidenceIds: [evidenceId] },
  );
  const insightId = db.all("SELECT id FROM insights")[0]?.id as number;
  const call = (name: keyof typeof routes, body?: unknown) =>
    send(server.port, routes[name].path, headers, routes[name].method, body);
  return { call, insightId, evidenceId };
}

describe("the registry boot builds reaches the read paths", () => {
  it("shows the row on the default registry (the control the other cases differ from)", async () => {
    const { call, insightId, evidenceId } = await boot();
    expect((await call("sources")).body).toMatchObject({ sources: [{ title: "제목 s" }] });
    expect((await call("searchSources", { query: "등대" })).body).toMatchObject({
      sources: [{ title: "제목 s" }],
    });
    expect((await call("insights")).body).toMatchObject({ insights: [{ summary: "요약" }] });
    expect((await call("insightEvidence", { insightId })).status).toBe(200);
    expect((await call("evidenceSource", { evidenceId })).status).toBe(200);
  });

  it("the Sources list", async () => {
    const { asked, registry } = hiding();
    const { call } = await boot(registry);
    expect((await call("sources")).body).toEqual({ sources: [] });
    expect(asked).toContain("source");
  });

  it("the keyword search", async () => {
    const { asked, registry } = hiding();
    const { call } = await boot(registry);
    expect((await call("searchSources", { query: "등대" })).body).toEqual({ sources: [] });
    expect(asked).toContain("source");
  });

  it("Home's Insight list", async () => {
    const { asked, registry } = hiding();
    const { call } = await boot(registry);
    expect((await call("insights")).body).toEqual({ insights: [] });
    expect(asked).toContain("insight");
  });

  it("an Insight's evidence list", async () => {
    const { asked, registry } = hiding();
    const { call, insightId } = await boot(registry);
    const res = await call("insightEvidence", { insightId });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not-found" });
    expect(asked).toContain("insight");
  });

  it("the source an evidence row opens", async () => {
    const { asked, registry } = hiding();
    const { call, evidenceId } = await boot(registry);
    const res = await call("evidenceSource", { evidenceId });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not-found" });
    expect(asked).toContain("evidence");
  });
});
