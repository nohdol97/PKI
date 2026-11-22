// I04-R13, I04-T04 (C1 `read-gate`, the wrapped engine's path): the backend takes the engine only as the
// registry wraps it, and the wrapped `relatedContext` drops what `visible` drops: a hit whose source version
// is gone or covered by a tombstone, and a hit the scope policy does not allow for the purpose. The
// product code does not call `relatedContext` yet (V02-C5), so the path is proved by calling the wrapper.
import type { ContextHit, KnowledgeEngine } from "@pki/contracts";
import {
  migrate,
  registerConnectorInstance,
  saveSourceRecord,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { MemoryKnowledgeEngine, seedLegacyTombstone } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProductRegistry } from "../canonical-kinds.ts";
import { createVisibleEngine } from "./visible-engine.ts";

const permissive: ScopePolicy = {
  compare: () => "equal",
  strictest: (scopes) => scopes[0] ?? null,
  combinable: () => true,
  allows: () => true,
};

let db: SqlDriver;
let inner: MemoryKnowledgeEngine;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  inner = new MemoryKnowledgeEngine();
});
afterEach(() => db.close());

async function ingest(externalId: string, body: string, accessScope?: string[]) {
  const saved = saveSourceRecord(db, "c1", {
    externalId,
    title: externalId,
    body,
    ...(accessScope ? { accessScope } : {}),
  });
  if (saved.status !== "created") throw new Error(saved.status);
  await inner.upsertSource(
    { ref: { sourceId: String(saved.sourceId), version: saved.version }, title: externalId, body },
    { version: saved.version },
    1,
  );
  return saved;
}

const wrap = (policy: ScopePolicy = permissive): KnowledgeEngine =>
  createVisibleEngine(inner, { db, registry: createProductRegistry({ policy }) });
const ids = (hits: ContextHit[]) => hits.map((h) => h.ref.sourceId).sort();

describe("the wrapped engine's relatedContext", () => {
  it("returns what the engine returns while nothing covers a source", async () => {
    const a = await ingest("a", "lighthouse keeper");
    const b = await ingest("b", "lighthouse tower");
    const hits = await wrap().relatedContext({ text: "lighthouse", limit: 10 });
    expect(ids(hits)).toEqual([String(a.sourceId), String(b.sourceId)].sort());
  });

  it("drops a hit whose source a tombstone covers though the purge has not run (read-gate)", async () => {
    const a = await ingest("a", "lighthouse keeper");
    const b = await ingest("b", "lighthouse tower");
    seedLegacyTombstone(db, {
      sourceId: a.sourceId,
      version: 1,
      at: "2026-11-22T00:00:00Z",
      reason: "user-deleted",
    });
    // the engine still holds a's item; the version row is stored and covered
    expect(ids(await inner.relatedContext({ text: "lighthouse", limit: 10 }))).toHaveLength(2);
    const hits = await wrap().relatedContext({ text: "lighthouse", limit: 10 });
    expect(ids(hits)).toEqual([String(b.sourceId)]);
  });

  it("drops a hit whose version is gone from the store", async () => {
    const a = await ingest("a", "lighthouse keeper");
    db.run("DELETE FROM source_versions WHERE source_id = ?", [a.sourceId]);
    expect(await wrap().relatedContext({ text: "lighthouse", limit: 10 })).toEqual([]);
  });

  it("keeps the engine's score and order for what stays", async () => {
    await ingest("a", "lighthouse");
    await ingest("b", "lighthouse tower keeper");
    const direct = await inner.relatedContext({ text: "lighthouse tower", limit: 10 });
    expect(await wrap().relatedContext({ text: "lighthouse tower", limit: 10 })).toEqual(direct);
  });

  it("asks the policy for the search purpose and drops what it does not allow", async () => {
    const a = await ingest("a", "lighthouse", ["team-x"]);
    const b = await ingest("b", "lighthouse", ["team-y"]);
    const purposes: string[] = [];
    const policy: ScopePolicy = {
      ...permissive,
      allows: (scopes, purpose) => {
        purposes.push(purpose);
        return JSON.stringify(scopes) !== JSON.stringify([["team-x"]]);
      },
    };
    const hits = await wrap(policy).relatedContext({ text: "lighthouse", limit: 10 });
    expect(ids(hits)).toEqual([String(b.sourceId)]);
    expect(new Set(purposes)).toEqual(new Set(["search"]));
    expect(a.sourceId).not.toBe(b.sourceId);
  });

  it("fails closed when the policy cannot judge: the call rejects instead of returning hits", async () => {
    await ingest("a", "lighthouse");
    const policy: ScopePolicy = {
      ...permissive,
      allows: () => {
        throw new Error("no policy yet");
      },
    };
    await expect(wrap(policy).relatedContext({ text: "lighthouse", limit: 10 })).rejects.toThrow();
  });

  it("passes every other member through to the engine unchanged", async () => {
    const wrapped = wrap();
    expect(wrapped.id).toBe(inner.id);
    expect(wrapped.capabilities()).toEqual(inner.capabilities());
    expect(await wrapped.appliedChangeSeq()).toBe(await inner.appliedChangeSeq());
    await wrapped.upsertSource(
      { ref: { sourceId: "9", version: 1 }, title: "t", body: "x" },
      { version: 1 },
      5,
    );
    expect(await inner.appliedChangeSeq()).toBe(5);
  });
});
