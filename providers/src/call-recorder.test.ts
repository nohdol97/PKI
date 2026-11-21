// V01-R13 history (T07 handoff 3): one provider_calls row per attempt, with the
// reason code of a blocked attempt and no destination when none was decided.
// Only the known fields are written, so nothing else a record carries reaches the DB.
import { listProviderCalls, migrate, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallRecord } from "./broker.ts";
import { createCallRecorder } from "./call-recorder.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const at = () => new Date("2026-11-21T01:02:03Z");
const base = {
  requestId: "req-1",
  providerId: "claude-code",
  taskKind: "connection-test",
  classification: "synthetic",
} as const;

describe("createCallRecorder", () => {
  it("writes a run attempt and a blocked attempt, newest first, labelled external", () => {
    const recorder = createCallRecorder(db, at);
    recorder.record({
      ...base,
      attempt: 1,
      outcome: "provider-error",
      destination: "vendor:claude-code",
      policyVersion: "pv-1",
      durationMs: 12,
    });
    recorder.record({ ...base, attempt: 2, outcome: "blocked", reason: "no-consent" });
    expect(listProviderCalls(db)).toEqual([
      {
        requestId: "req-1",
        attempt: 2,
        provider: "claude-code",
        egress: "external",
        destination: null,
        taskKind: "connection-test",
        classification: "synthetic",
        policyVersion: null,
        outcome: "blocked",
        reason: "no-consent",
        durationMs: null,
        createdAt: "2026-11-21T01:02:03.000Z",
      },
      {
        requestId: "req-1",
        attempt: 1,
        provider: "claude-code",
        egress: "external",
        destination: "vendor:claude-code",
        taskKind: "connection-test",
        classification: "synthetic",
        policyVersion: "pv-1",
        outcome: "provider-error",
        reason: null,
        durationMs: 12,
        createdAt: "2026-11-21T01:02:03.000Z",
      },
    ]);
  });

  it("keeps the Provider-facing request ID recoverable as <requestId>:<attempt>", () => {
    const recorder = createCallRecorder(db, at);
    recorder.record({
      ...base,
      attempt: 3,
      outcome: "timeout",
      destination: "d",
      policyVersion: "p",
      durationMs: 1,
    });
    const [row] = listProviderCalls(db);
    expect(`${row?.requestId}:${row?.attempt}`).toBe("req-1:3");
  });

  it("writes only the known fields, and replaces a reason that is not a code", () => {
    const recorder = createCallRecorder(db, at);
    const carrying = {
      ...base,
      attempt: 1,
      outcome: "blocked",
      reason: "Provider said: SECRET-CANARY body text",
      body: "SECRET-CANARY",
      prompt: "SECRET-CANARY",
    } as unknown as CallRecord;
    recorder.record(carrying);
    const dump = JSON.stringify(db.all("SELECT * FROM provider_calls"));
    expect(dump).not.toContain("SECRET-CANARY");
    expect(listProviderCalls(db)[0]?.reason).toBe("unrecognized-reason");
  });

  it("labels the local model Provider as local and anything unknown as external", () => {
    const recorder = createCallRecorder(db, at);
    recorder.record({
      ...base,
      providerId: "local-model",
      attempt: 1,
      outcome: "blocked",
      reason: "no-consent",
    });
    db.run(
      `INSERT INTO provider_calls (request_id, attempt, provider, task_kind, classification,
         outcome, reason, created_at)
       VALUES ('r2', 1, 'some-fork-provider', 'extract', 'general', 'blocked', 'no-consent', 't')`,
    );
    expect(listProviderCalls(db).map((c) => [c.provider, c.egress])).toEqual([
      ["some-fork-provider", "external"],
      ["local-model", "local"],
    ]);
  });
});
