// Reads behind the screens (V01-R3): the source list and keyword search show each
// source's latest version only, and the provider call history is newest first.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { findSources, listProviderCalls, listSources } from "./listing.ts";
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
      { id: 3, connectorId: "c1", externalId: "a", title: "등대 점검 확정" },
      { id: 2, connectorId: "c1", externalId: "b", title: "Harbor budget" },
    ]);
  });

  it("honours the limit", () => {
    expect(listSources(db, 1)).toHaveLength(1);
  });
});

describe("findSources", () => {
  it("returns matching sources by their latest version only", () => {
    expect(findSources(db, "등대")).toEqual([
      { id: 3, connectorId: "c1", externalId: "a", title: "등대 점검 확정" },
    ]);
    expect(findSources(db, "초안")).toEqual([]);
    expect(findSources(db, "pier")).toEqual([
      { id: 2, connectorId: "c1", externalId: "b", title: "Harbor budget" },
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
