// I02B-C31 (R29): a thread comes back in time order whatever order its messages arrived in.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryDbTemplate } from "@pki/testkit";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { readThread } from "./thread.ts";
import { recordTombstone } from "./tombstones.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);
let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  for (const id of ["c1", "c2"]) registerConnectorInstance(db, id, "test-fixtures");
});
afterEach(() => {
  db.close();
});

interface Message {
  id: string;
  createdAt?: string;
  author: string;
  participants?: string[];
}
/** Seven messages: `+09:00` and `Z` mixed, two at the same instant, two without a date. */
const MESSAGES: Message[] = [
  {
    id: "m-a",
    createdAt: "2026-11-10T09:00:00+09:00",
    author: "kim",
    participants: ["kim", "lee"],
  },
  { id: "m-b", createdAt: "2026-11-10T00:30:00Z", author: "lee" },
  { id: "m-d", createdAt: "2026-11-10T10:30:00+09:00", author: "lee", participants: ["choi"] },
  { id: "m-c", createdAt: "2026-11-10T01:30:00Z", author: "park" },
  { id: "m-g", createdAt: "2026-11-10T02:00:00Z", author: "kim" },
  { id: "nodate-b", author: "lee" },
  { id: "nodate-a", author: "han" },
];
const EXPECTED_ORDER = ["m-a", "m-b", "m-c", "m-d", "m-g", "nodate-a", "nodate-b"];
const EXPECTED_PARTICIPANTS = ["kim", "lee", "park", "choi", "han"];

/** A fixed-seed shuffle: the same twenty arrival orders on every run. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const save = (instance: string, m: Message, threadId = "th-1", body = "b") =>
  saveSourceRecord(db, instance, {
    externalId: m.id,
    title: m.id,
    body,
    revision: 1,
    provenance: {
      author: m.author,
      participants: m.participants,
      threadId,
      createdAt: m.createdAt,
    },
  });

describe("C31 readThread", () => {
  it("orders by instant, then by id, undated last, in every arrival order, and lists participants in that order", () => {
    const results: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const fresh = freshDb();
      registerConnectorInstance(fresh, "c1", "test-fixtures");
      db.close();
      db = fresh;
      for (const m of shuffled(MESSAGES, seed)) save("c1", m);
      const thread = readThread(db, "c1", "th-1");
      results.push(JSON.stringify([thread.messages.map((x) => x.externalId), thread.participants]));
    }
    expect(new Set(results).size).toBe(1);
    expect(JSON.parse(results[0] as string)).toEqual([EXPECTED_ORDER, EXPECTED_PARTICIPANTS]);
  });

  it("reads the latest version, stays inside its instance and thread, and drops a tombstoned message", () => {
    for (const m of MESSAGES) save("c1", m);
    save("c2", { id: "other-instance", author: "x" });
    save("c1", { id: "other-thread", author: "x" }, "th-2");
    saveSourceRecord(db, "c1", {
      externalId: "m-b",
      title: "m-b",
      body: "edited",
      revision: 2,
      provenance: { author: "lee", threadId: "th-1", createdAt: "2026-11-10T00:30:00Z" },
    });
    const gone = db.all("SELECT id FROM sources WHERE external_id = 'm-g'")[0]?.id as number;
    recordTombstone(db, gone, {
      reason: "source-deleted",
      lastRevision: 1,
      at: "2026-11-11T00:00:00Z",
    });
    const thread = readThread(db, "c1", "th-1");
    expect(thread.messages.map((m) => m.externalId)).toEqual([
      "m-a",
      "m-b",
      "m-c",
      "m-d",
      "nodate-a",
      "nodate-b",
    ]);
    expect(thread.messages.find((m) => m.externalId === "m-b")?.body).toBe("edited");
  });
});
