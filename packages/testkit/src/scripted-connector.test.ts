// I01-R26: the scripted Connector replays set pages, errors, rate limits, expiry,
// out-of-order revisions, tombstones and scope changes in order, so the management
// module's sync tests (I01-T03) can stage each case.
import {
  ConnectorError,
  ConnectorRateLimitError,
  type Change,
  type SourceRecord,
} from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { ScriptedConnector, type ConnectorScript, type ScriptEntry } from "./scripted-connector.ts";

const AT = "2026-11-22T00:00:00Z";
const record = (
  externalId: string,
  revision = 1,
  patch: Partial<SourceRecord> = {},
): SourceRecord => ({
  namespace: "",
  externalId,
  revision,
  schemaVersion: 2,
  title: externalId,
  body: `body of ${externalId}`,
  ...patch,
});
const upsert = (r: SourceRecord): Change => ({ kind: "upsert", record: r });
const signal = () => new AbortController().signal;

async function started(script: ConnectorScript) {
  const connector = new ScriptedConnector();
  await connector.initialize(script);
  return connector;
}
const ENTRIES: ScriptEntry[] = ["a", "b", "c", "d", "e"].map((id) => upsert(record(id)));

describe("ScriptedConnector", () => {
  it("declares a valid v2 manifest by default and takes the capabilities it is given", () => {
    expect(new ScriptedConnector().manifest).toEqual({
      type: "scripted",
      schemaVersion: 2,
      capabilities: {
        incremental: true,
        deletes: false,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
      },
    });
    const custom = new ScriptedConnector({
      type: "t",
      schemaVersion: 1,
      capabilities: { deletes: true },
    });
    expect(custom.manifest.type).toBe("t");
    expect(custom.manifest.schemaVersion).toBe(1);
    expect(custom.manifest.capabilities.deletes).toBe(true);
  });

  it("answers nothing before initialization, and refuses a config that is not a script", async () => {
    const connector = new ScriptedConnector();
    expect(await connector.healthCheck()).toEqual({
      state: "unavailable",
      reason: "not initialized",
    });
    await expect(connector.getChanges(null, { limit: 1, signal: signal() })).rejects.toThrow();
    await expect(connector.getDocument({ namespace: "", externalId: "a" })).rejects.toThrow();
    const refused = await connector.initialize({ changes: [] }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectorError);
    expect((refused as ConnectorError).retryable).toBe(false);
  });

  it("serves the entries in pages of min(pageSize, limit) with offset cursors", async () => {
    const connector = await started({ entries: ENTRIES });
    expect(await connector.healthCheck()).toEqual({ state: "ok" });
    const first = await connector.getChanges(null, { limit: 1000, signal: signal() });
    expect(first.changes).toEqual(ENTRIES.slice(0, 2));
    expect(first).toMatchObject({ nextCursor: "offset:2", hasMore: true, rejected: [] });
    const narrow = await connector.getChanges("offset:2", { limit: 1, signal: signal() });
    expect(narrow.changes).toEqual(ENTRIES.slice(2, 3));
    expect(narrow.nextCursor).toBe("offset:3");
    const wide = await started({ entries: ENTRIES, pageSize: 10 });
    const all = await wide.getChanges(null, { limit: 1000, signal: signal() });
    expect(all).toMatchObject({ changes: ENTRIES, nextCursor: "offset:5", hasMore: false });
    const done = await wide.getChanges("offset:5", { limit: 1000, signal: signal() });
    expect(done).toMatchObject({ changes: [], nextCursor: "offset:5", hasMore: false });
  });

  it("answers an unknown cursor as expired", async () => {
    const connector = await started({ entries: ENTRIES });
    for (const cursor of ["nope", "offset:9", "offset:-1"]) {
      expect(await connector.getChanges(cursor, { limit: 10, signal: signal() })).toEqual({
        changes: [],
        nextCursor: "",
        hasMore: false,
        cursorExpired: true,
        rejected: [],
      });
    }
  });

  it("puts rejected entries in the page's rejected list, each taking a slot", async () => {
    const connector = await started({
      entries: [
        upsert(record("a")),
        { kind: "rejected", at: "line:2", code: "schema" },
        upsert(record("b")),
      ],
    });
    const page = await connector.getChanges(null, { limit: 10, signal: signal() });
    expect(page.changes).toEqual([upsert(record("a"))]);
    expect(page.rejected).toEqual([{ at: "line:2", code: "schema" }]);
    expect(page.nextCursor).toBe("offset:2");
  });

  it("raises a fault on its cursor as many times as asked, then serves the page; every call is logged", async () => {
    const limited = new ConnectorRateLimitError("slow down", { retryAfterMs: 1000 });
    const failing = new ConnectorError("origin hiccup", { retryable: true });
    const connector = await started({
      entries: ENTRIES,
      faults: [
        { cursor: "offset:2", raise: limited },
        { cursor: "offset:4", raise: failing, times: 2 },
      ],
    });
    const opts = { limit: 1000, signal: signal() };
    await connector.getChanges(null, opts);
    await expect(connector.getChanges("offset:2", opts)).rejects.toBe(limited);
    expect((await connector.getChanges("offset:2", opts)).nextCursor).toBe("offset:4");
    await expect(connector.getChanges("offset:4", opts)).rejects.toBe(failing);
    await expect(connector.getChanges("offset:4", opts)).rejects.toBe(failing);
    expect((await connector.getChanges("offset:4", opts)).hasMore).toBe(false);
    expect(connector.calls.map((c) => [c.cursor, c.limit])).toEqual([
      [null, 1000],
      ["offset:2", 1000],
      ["offset:2", 1000],
      ["offset:4", 1000],
      ["offset:4", 1000],
      ["offset:4", 1000],
    ]);
  });

  it("expires a cursor on request; a fault without a cursor matches any call", async () => {
    const connector = await started({
      entries: ENTRIES,
      faults: [{ cursor: "offset:2", expire: true }, { raise: new Error("first call fails") }],
    });
    const opts = { limit: 1000, signal: signal() };
    await expect(connector.getChanges(null, opts)).rejects.toThrow("first call fails");
    await connector.getChanges(null, opts);
    expect(await connector.getChanges("offset:2", opts)).toMatchObject({
      changes: [],
      cursorExpired: true,
    });
    expect((await connector.getChanges("offset:2", opts)).changes).toHaveLength(2);
  });

  it("waits for beforeAnswer and then honours the signal, so a test can abort mid-sync", async () => {
    const controller = new AbortController();
    const connector = await started({
      entries: ENTRIES,
      beforeAnswer: (call) => {
        if (call.cursor === "offset:2") controller.abort();
      },
    });
    const opts = { limit: 1000, signal: controller.signal };
    await connector.getChanges(null, opts);
    await expect(connector.getChanges("offset:2", opts)).rejects.toThrow();
    expect(connector.calls).toHaveLength(2);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      connector.getChanges(null, { limit: 1, signal: aborted.signal }),
    ).rejects.toThrow();
  });

  it("returns from getDocument the script folded: highest revision, later scope, null after a tombstone", async () => {
    const connector = await started({
      entries: [
        upsert(record("a", 1)),
        upsert(record("a", 3)),
        upsert(record("a", 2)),
        {
          kind: "scope-change",
          namespace: "",
          externalId: "a",
          revision: 3,
          accessScope: ["x"],
          at: AT,
        },
        upsert(record("b")),
        { kind: "delete", namespace: "", externalId: "b", revision: 1, at: AT },
        upsert(record("c")),
        { kind: "access-revoked", namespace: "", externalId: "c", revision: 1, at: AT },
        { kind: "delete", namespace: "", externalId: "d", revision: 1, at: AT },
        upsert(record("d", 2)),
      ],
    });
    expect(await connector.getDocument({ namespace: "", externalId: "a" })).toEqual(
      record("a", 3, { accessScope: ["x"] }),
    );
    expect(await connector.getDocument({ namespace: "", externalId: "b" })).toBeNull();
    expect(await connector.getDocument({ namespace: "", externalId: "c" })).toBeNull();
    expect(await connector.getDocument({ namespace: "", externalId: "d" })).toEqual(record("d", 2));
    expect(await connector.getDocument({ namespace: "other", externalId: "d" })).toBeNull();
  });
});
