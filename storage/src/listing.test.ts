// Reads behind the screens (V01-R3): the source list and keyword search show each
// source's latest version only, and the provider call history is newest first.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  finishProviderCall,
  findSources,
  insertProviderCall,
  interruptStartedCalls,
  listAttemptTimes,
  listProviderCalls,
  listSources,
  type ProviderCallRow,
} from "./listing.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  saveSourceRecord(db, "c1", { externalId: "a", title: "등대 점검 초안", body: "합성 자료" });
  saveSourceRecord(db, "c1", { externalId: "b", title: "Harbor budget", body: "synthetic pier" });
  saveSourceRecord(db, "c1", { externalId: "a", title: "등대 점검 확정", body: "합성 자료" });
});

afterEach(() => {
  db.close();
});

describe("listSources", () => {
  it("lists the latest version of each source, newest first", () => {
    expect(listSources(db)).toEqual([
      { id: 3, connectorId: "c1", namespace: "", externalId: "a", title: "등대 점검 확정" },
      { id: 2, connectorId: "c1", namespace: "", externalId: "b", title: "Harbor budget" },
    ]);
  });

  it("honours the limit", () => {
    expect(listSources(db, 1)).toHaveLength(1);
  });
});

describe("findSources", () => {
  it("returns matching sources by their latest version only", () => {
    expect(findSources(db, "등대")).toEqual([
      { id: 3, connectorId: "c1", namespace: "", externalId: "a", title: "등대 점검 확정" },
    ]);
    expect(findSources(db, "초안")).toEqual([]);
    expect(findSources(db, "pier")).toEqual([
      { id: 2, connectorId: "c1", namespace: "", externalId: "b", title: "Harbor budget" },
    ]);
  });

  it("orders results by match rank, not by insertion", () => {
    // Same length; more hits ranks higher. Rank order (strong, medium, weak) is neither
    // insertion order nor its reverse.
    const save = (externalId: string, body: string) =>
      saveSourceRecord(db, "c1", { externalId, title: externalId, body });
    save("weak", "봉화 하나 둘 셋 넷");
    save("strong", "봉화 봉화 봉화 봉화");
    save("medium", "봉화 봉화 하나 둘");
    expect(findSources(db, "봉화").map((s) => s.externalId)).toEqual(["strong", "medium", "weak"]);
  });

  it("applies the limit after keeping latest versions only", () => {
    // Old versions repeating the term outrank the latest ones; they must not use up the limit.
    for (let i = 0; i < 60; i++) {
      saveSourceRecord(db, "c1", { externalId: "c", title: `등대 등대 등대 ${i}`, body: "등대" });
    }
    saveSourceRecord(db, "c1", { externalId: "c", title: "등대 최신", body: "합성 자료 본문" });
    expect(findSources(db, "등대", 50).map((s) => s.title)).toEqual(
      expect.arrayContaining(["등대 최신", "등대 점검 확정"]),
    );
    expect(findSources(db, "등대", 1)).toHaveLength(1);
  });

  it("finds nothing for a blank query", () => {
    expect(findSources(db, "  ")).toEqual([]);
  });
});

describe("listProviderCalls", () => {
  const insert = (requestId: string, attempt: number, durationMs: number | null) =>
    db.run(
      `INSERT INTO provider_calls (request_id, attempt, provider, destination, task_kind,
         classification, policy_version, outcome, duration_ms, created_at)
       VALUES (?, ?, 'fake', 'synthetic.example', 'connection-test', 'synthetic', 'p1', 'ok', ?,
         '2026-11-21T00:00:00Z')`,
      [requestId, attempt, durationMs],
    );

  it("is empty until a call is recorded", () => {
    expect(listProviderCalls(db)).toEqual([]);
  });

  it("lists recorded attempts newest first", () => {
    insert("r1", 1, 12);
    insert("r1", 2, null);
    expect(listProviderCalls(db)).toEqual([
      {
        requestId: "r1",
        attempt: 2,
        provider: "fake",
        egress: "external",
        destination: "synthetic.example",
        taskKind: "connection-test",
        classification: "synthetic",
        policyVersion: "p1",
        outcome: "ok",
        reason: null,
        durationMs: null,
        createdAt: "2026-11-21T00:00:00Z",
      },
      expect.objectContaining({ attempt: 1, durationMs: 12 }),
    ]);
  });
});

describe("started attempts (I03-R14, I03-T06)", () => {
  const row = (requestId: string, outcome: string, createdAt: string): ProviderCallRow => ({
    requestId,
    attempt: 1,
    provider: "fake",
    destination: "synthetic.example",
    taskKind: "connection-test",
    classification: "synthetic",
    policyVersion: "p1",
    outcome,
    reason: outcome === "blocked" || outcome === "budget-exhausted" ? "x" : null,
    durationMs: null,
    createdAt,
  });

  it("insertProviderCall returns the row's ID and finishProviderCall sets its result once", () => {
    const id = insertProviderCall(db, row("r1", "started", "2026-11-21T00:00:00.000Z"));
    expect(listProviderCalls(db)[0]).toMatchObject({ outcome: "started", durationMs: null });
    finishProviderCall(db, id, { outcome: "ok", durationMs: 7 });
    expect(listProviderCalls(db)[0]).toMatchObject({ outcome: "ok", durationMs: 7 });
    // a finished row is never overwritten by a late fix
    finishProviderCall(db, id, { outcome: "timeout", durationMs: 9 });
    expect(listProviderCalls(db)[0]).toMatchObject({ outcome: "ok", durationMs: 7 });
  });

  it("interruptStartedCalls turns only started rows into interrupted and counts them", () => {
    insertProviderCall(db, row("r1", "started", "2026-11-21T00:00:00.000Z"));
    insertProviderCall(db, row("r2", "ok", "2026-11-21T00:00:01.000Z"));
    expect(interruptStartedCalls(db)).toBe(1);
    expect(listProviderCalls(db).map((c) => c.outcome)).toEqual(["ok", "interrupted"]);
    expect(interruptStartedCalls(db)).toBe(0);
  });

  it("listAttemptTimes lists attempts after the cut, started and interrupted included, blocked and budget-exhausted not", () => {
    insertProviderCall(db, row("a", "ok", "2026-11-21T00:00:00.000Z"));
    insertProviderCall(db, row("b", "started", "2026-11-21T00:10:00.000Z"));
    insertProviderCall(db, row("c", "interrupted", "2026-11-21T00:20:00.000Z"));
    insertProviderCall(db, row("d", "blocked", "2026-11-21T00:30:00.000Z"));
    insertProviderCall(db, row("e", "budget-exhausted", "2026-11-21T00:40:00.000Z"));
    insertProviderCall(db, row("f", "cancelled", "2026-11-21T00:50:00.000Z"));
    const at = (iso: string) => Date.parse(iso);
    // exactly at the cut is outside the window (the Broker's own rule)
    expect(listAttemptTimes(db, at("2026-11-21T00:00:00.000Z"))).toEqual([
      at("2026-11-21T00:10:00.000Z"),
      at("2026-11-21T00:20:00.000Z"),
      at("2026-11-21T00:50:00.000Z"),
    ]);
  });
});
