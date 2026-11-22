// I01-R23: the JSONL Connector (SDK v2) over the V02 synthetic fixtures passes the
// Connector contract, never forwards the fixtures' malicious marker, reads its file
// through the SDK's parser, and its cursor is `<sha256 of the file>:<entries given>`.
// It also takes lines already parsed by the V02 screen's importer (`{ records }`).
import { MAX_JSONL_BYTES, parseJsonl } from "@pki/connector-sdk";
import { ConnectorError, type ImportRecord } from "@pki/contracts";
import { connectorContract } from "@pki/testkit";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createJsonlConnector } from "./jsonl-connector.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
/** Every V02 fixture line; the messenger-type instance has three sources in them. */
const ALL = readdirSync(FIXTURES)
  .filter((f) => /^v02-.*\.jsonl$/.test(f))
  .map(fixture)
  .join("\n");

// a folder of the ignored test output (an adapter's test may not import node:os)
const SCRATCH = resolve(import.meta.dirname, "../../../.vitest/jsonl-connector");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "t-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
/** A file holding `text`; returns its path. */
const fileOf = (text: string) => {
  const path = join(dir, `f${counter++}.jsonl`);
  writeFileSync(path, text);
  return path;
};

/** The parsed records of one instance, as the screen's importer hands them over. */
const recordsOf = (text: string, instance: string) =>
  parseJsonl(text)
    .lines.map((l) => l.record)
    .filter((r) => r.connector_instance_id === instance);

const MAIL = JSON.parse(fixture("v02-mail.jsonl").trim()) as ImportRecord;
const hashOf = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
/** The mail fixture with fields replaced; the content hash follows the content. */
const line = (patch: Partial<ImportRecord> & Record<string, unknown> = {}) => {
  const record = { ...MAIL, ...patch };
  return JSON.stringify(
    "content" in patch && !("content_hash" in patch)
      ? { ...record, content_hash: hashOf(record.content) }
      : record,
  );
};
connectorContract("jsonl-import (a file)", createJsonlConnector, {
  config: { path: fileOf(ALL) },
  later: { path: fileOf(`${ALL}\n${line({ external_id: "later-1" })}`) },
});
// B-F3: a source with several versions in one file (each line a version), and a later state with
// a line removed, both pass the contract suite for this collector
connectorContract("jsonl-import (versions of one source, a removed line)", createJsonlConnector, {
  config: {
    path: fileOf(
      [
        line({ external_id: "v" }),
        line({ external_id: "w" }),
        line({ external_id: "v", version: 2, content: "second" }),
        line({ external_id: "v", version: 3, content: "third" }),
      ].join("\n"),
    ),
  },
  // w's line is gone, v has a fourth version
  later: {
    path: fileOf(
      [
        line({ external_id: "v" }),
        line({ external_id: "v", version: 2, content: "second" }),
        line({ external_id: "v", version: 3, content: "third" }),
        line({ external_id: "v", version: 4, content: "fourth" }),
      ].join("\n"),
    ),
  },
  versionedSources: true,
});
connectorContract("jsonl-import (parsed lines)", createJsonlConnector, {
  config: { records: recordsOf(ALL, "conn-v02-chat") },
});

const signal = () => new AbortController().signal;

async function opened(config: unknown) {
  const connector = createJsonlConnector();
  await connector.initialize(config);
  return connector;
}
async function changesOf(text: string) {
  const connector = await opened({ path: fileOf(text) });
  return (await connector.getChanges(null, { limit: 1000, signal: signal() })).changes;
}

describe("JSONL Connector: mapping (I01-R22)", () => {
  it("emits the line's source facts, its version as the revision and its connector_instance_id as the namespace, and no malicious marker", async () => {
    const malicious = fixture("v02-malicious.jsonl");
    expect(malicious).toContain('"malicious":true');
    const changes = await changesOf(malicious);
    const [change] = changes;
    const source = JSON.parse(malicious.split("\n")[0] as string) as ImportRecord;
    expect(change?.kind === "upsert" && Object.keys(change.record).sort()).toEqual([
      "accessScope",
      "author",
      "body",
      "createdAt",
      "externalId",
      "metadata",
      "namespace",
      "participants",
      "revision",
      "schemaVersion",
      "sourceType",
      "sourceUrl",
      "threadId",
      "title",
      "updatedAt",
    ]);
    expect(change).toMatchObject({
      kind: "upsert",
      record: {
        namespace: source.connector_instance_id,
        externalId: source.external_id,
        revision: source.version,
        schemaVersion: 2,
        title: source.title,
        body: source.content,
        accessScope: source.access_scope,
      },
    });
  });

  it("declares deletionsOnRescan false: a removed line is no deletion (I01-R23)", () => {
    expect(createJsonlConnector().manifest.capabilities).toEqual({
      incremental: true,
      deletes: true,
      accessScope: true,
      fullRescan: true,
      deletionsOnRescan: false,
    });
  });

  it("hands delete, access-revoked and revoke lines on as a tombstone event, a tombstone event and a scope change", async () => {
    const at = "2026-11-04T09:00:00+09:00";
    const changes = await changesOf(
      [
        line({ external_id: "d", operation: "delete", content: "", version: 3, updated_at: at }),
        line({ external_id: "a", operation: "access-revoked", version: 2, updated_at: at }),
        line({ external_id: "r", operation: "revoke", version: 2, updated_at: at }),
      ].join("\n"),
    );
    const ns = MAIL.connector_instance_id;
    expect(changes).toEqual([
      { kind: "delete", namespace: ns, externalId: "d", revision: 3, at },
      { kind: "access-revoked", namespace: ns, externalId: "a", revision: 2, at },
      {
        kind: "scope-change",
        namespace: ns,
        externalId: "r",
        revision: 2,
        at,
        accessScope: MAIL.access_scope,
      },
    ]);
  });

  it("answers getDocument with the latest upsert of a source, and null for a deleted or unknown one", async () => {
    const ns = MAIL.connector_instance_id;
    const connector = await opened({
      path: fileOf(
        [
          line({ external_id: "a", content: "first" }),
          line({ external_id: "a", version: 2, content: "second" }),
          line({ external_id: "gone" }),
          line({ external_id: "gone", version: 2, operation: "delete", content: "" }),
        ].join("\n"),
      ),
    });
    expect(await connector.getDocument({ namespace: ns, externalId: "a" })).toMatchObject({
      body: "second",
      revision: 2,
    });
    expect(await connector.getDocument({ namespace: ns, externalId: "gone" })).toBeNull();
    expect(await connector.getDocument({ namespace: ns, externalId: "unknown" })).toBeNull();
  });

  it("takes parsed lines in the namespace of their connector_instance_id, and fails to initialize without a path or records", async () => {
    const connector = await opened({
      records: recordsOf(fixture("v02-mail.jsonl"), MAIL.connector_instance_id),
    });
    const { changes } = await connector.getChanges(null, { limit: 10, signal: signal() });
    expect(changes[0]).toMatchObject({
      kind: "upsert",
      record: { namespace: MAIL.connector_instance_id },
    });
    await expect(createJsonlConnector().initialize({ text: "" })).rejects.toThrow();
    await expect(createJsonlConnector().initialize({ path: "" })).rejects.toThrow();
    await expect(createJsonlConnector().initialize(null)).rejects.toThrow();
  });
});

describe("JSONL Connector: the cursor (I01-R23)", () => {
  const text = [1, 2, 3].map((n) => line({ external_id: `e${n}` })).join("\n");

  it("is the file's sha256 and the entries given; the same file again has nothing new", async () => {
    const path = fileOf(text);
    const connector = await opened({ path });
    const first = await connector.getChanges(null, { limit: 2, signal: signal() });
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(first).toMatchObject({ nextCursor: `${sha}:2`, hasMore: true });
    const second = await connector.getChanges(first.nextCursor, { limit: 2, signal: signal() });
    expect(second).toMatchObject({ nextCursor: `${sha}:3`, hasMore: false });
    expect(second.changes).toHaveLength(1);
    const again = await connector.getChanges(second.nextCursor, { limit: 2, signal: signal() });
    expect(again).toMatchObject({ changes: [], nextCursor: `${sha}:3`, hasMore: false });
    expect(again.cursorExpired).toBeUndefined();
  });

  it("expires when the file's content changed since the cursor was made (import.duplicate, sync.rescan ⑥)", async () => {
    const path = fileOf(text);
    const connector = await opened({ path });
    const read = await connector.getChanges(null, { limit: 2, signal: signal() });
    writeFileSync(path, `${text}\n${line({ external_id: "e4" })}`);
    expect(
      await connector.getChanges(read.nextCursor, { limit: 2, signal: signal() }),
    ).toMatchObject({
      cursorExpired: true,
    });
  });

  it.each(["", "5", "abc:1", `${"0".repeat(64)}:1`, `${"0".repeat(64)}:x`])(
    "expires on a cursor of another shape or file: %j",
    async (cursor) => {
      const connector = await opened({ path: fileOf(text) });
      expect(await connector.getChanges(cursor, { limit: 2, signal: signal() })).toMatchObject({
        cursorExpired: true,
      });
    },
  );

  it("expires on a count past the file's entries", async () => {
    const path = fileOf(text);
    const connector = await opened({ path });
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(await connector.getChanges(`${sha}:4`, { limit: 2, signal: signal() })).toMatchObject({
      cursorExpired: true,
    });
  });
});

describe("JSONL Connector: refused lines and pages (I01-R14, R22)", () => {
  it("reports a refused line by `line:<n>` and a code, never its text, and goes on", async () => {
    const canary = "CANARY-file-line-9921";
    const connector = await opened({
      path: fileOf(
        [
          line({ external_id: "ok-1" }),
          `{"${canary}": `,
          line({ external_id: "no-scope", access_scope: [], title: canary }),
          line({ external_id: "ok-2" }),
        ].join("\n"),
      ),
    });
    const page = await connector.getChanges(null, { limit: 10, signal: signal() });
    expect(page.changes).toHaveLength(2);
    expect(page.rejected).toEqual([
      { at: "line:2", code: "invalid-json" },
      { at: "line:3", code: "schema" },
    ]);
    expect(JSON.stringify(page.rejected)).not.toContain(canary);
  });

  it("fails a read with a plain non-retryable ConnectorError when the file is missing, and says nothing of the path", async () => {
    const path = join(dir, "no-such-CANARY-path.jsonl");
    const connector = await opened({ path });
    const error = await connector.getChanges(null, { limit: 10, signal: signal() }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).retryable).toBe(false);
    expect((error as ConnectorError).message).not.toContain("CANARY");
    expect(await connector.healthCheck()).toMatchObject({ state: "unavailable" });
  });

  it("refuses a file over the size limit before reading it", async () => {
    const connector = await opened({ path: fileOf("x".repeat(MAX_JSONL_BYTES + 1)) });
    const error = await connector.getChanges(null, { limit: 10, signal: signal() }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConnectorError);
  });
});
