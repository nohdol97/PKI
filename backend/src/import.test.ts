// I01-R22 to R24, C3 `import.*` and `sync.rescan` ⑥: the local import API (`importContent`)
// and the JSONL file collector over a real SQLite file, with synthetic lines only.
// Each describe is one proof test of the spec's table.
import { JSONL_IMPORT_KIND } from "@pki/connector-sdk";
import { SyncResponseSchema, type ImportRecord, type SyncResponse } from "@pki/contracts";
import {
  canonicalTransaction,
  identityKey,
  readChangeSeq,
  readCursor,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonlConnector } from "./adapters/jsonl-connector.ts";
import { openCanonicalDb, productImporter } from "./composition.ts";
import { createConnectorManager, tryLockInstance, type ConnectorManager } from "./connectors.ts";
import { importContent, type ImportOutcome } from "./imports.ts";
import { storePage } from "./page-store.ts";
import { applyTombstone } from "@pki/knowledge-engine";
import { JSONL_CAPABILITIES, parseJsonl } from "@pki/connector-sdk";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const GOLDEN_DIR = resolve(import.meta.dirname, "../../eval/golden/sources");
const CANARY = "CANARY-import-text-5530";

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-import-t05-"));
  db = openCanonicalDb(join(dir, "data"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const hashOf = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const BASE: ImportRecord = {
  id: "syn-0001",
  source_type: "mail",
  external_id: "a",
  title: "Synthetic title",
  content: "Synthetic body",
  author: "writer@example.test",
  participants: ["reader@example.test"],
  thread_id: "thread-1",
  source_url: "https://mail.example.test/1",
  created_at: "2026-11-01T09:00:00+09:00",
  updated_at: "2026-11-02T09:00:00+09:00",
  content_hash: hashOf("Synthetic body"),
  version: 1,
  access_scope: ["group:team", "user:writer"],
  metadata: {},
  connector_instance_id: "conn-a",
  operation: "upsert",
  schema_version: "1",
};
/** One line; the hash follows a replaced content unless given. */
const line = (patch: Partial<ImportRecord> & Record<string, unknown> = {}) => {
  const record: Record<string, unknown> = { ...BASE, ...patch };
  if ("content" in patch && !("content_hash" in patch))
    record.content_hash = hashOf(patch.content as string);
  return JSON.stringify(record);
};
const del = (id: string, version: number) =>
  line({ external_id: id, operation: "delete", content: "", version });

const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;
const state = () => ({
  sources: count("sources"),
  versions: count("source_versions"),
  tombstones: count("tombstones"),
  jobs: count("jobs"),
  changeSeq: readChangeSeq(db),
});

/** An import's answer that is a result, not an error. */
async function imported(content: string, instanceId = "inst", target: SqlDriver = db) {
  const outcome: ImportOutcome = await importContent(target, instanceId, content);
  if ("error" in outcome) throw new Error(`import answered ${outcome.error}`);
  return SyncResponseSchema.parse(outcome);
}
const counts = (r: SyncResponse) => ({
  received: r.received,
  created: r.created,
  unchanged: r.unchanged,
  scopeUpdated: r.scopeUpdated,
  stale: r.stale,
  staleTombstone: r.staleTombstone,
  blocked: r.blocked,
  tombstoned: r.tombstoned,
  rejectedCount: r.rejectedCount,
});

function fileOf(text: string, name = "file.jsonl") {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}
async function collector(path: string, id = "file"): Promise<ConnectorManager> {
  return createConnectorManager(db, [{ id, kind: JSONL_IMPORT_KIND, config: { path } }], {
    [JSONL_IMPORT_KIND]: createJsonlConnector,
  });
}
/** A sync's result; the instance is ready, so an error answer is a failure of the test. */
async function sync(m: ConnectorManager, id = "file"): Promise<SyncResponse> {
  const result = await m.sync(id);
  if ("error" in result) throw new Error(`sync answered ${result.error}`);
  return result;
}
/** A result without the instance's name, which differs by path. */
const noId = (r: SyncResponse) =>
  Object.fromEntries(Object.entries(r).filter(([key]) => key !== "connectorId"));

describe("import.schema-errors", () => {
  it("① refuses each bad line by `line:<n>` and its code, and stores the others", async () => {
    const result = await imported(
      [
        line({ external_id: "ok-1" }), // 1
        "{not json", // 2
        JSON.stringify({ ...BASE, external_id: undefined }), // 3: a field is missing
        line({ external_id: "empty", access_scope: [] }), // 4
        line({ external_id: "bad-hash", content_hash: hashOf("other") }), // 5
        line({
          external_id: "ok-1",
          operation: "revoke",
          content: "not the stored content",
          version: 2,
        }), // 6
        line({ external_id: "ok-2" }), // 7
      ].join("\n"),
    );
    expect(result.rejected).toEqual([
      { at: "line:2", code: "invalid-json" },
      { at: "line:3", code: "schema" },
      { at: "line:4", code: "schema" },
      { at: "line:5", code: "content-hash-mismatch" },
      { at: "line:6", code: "scope-change-content-mismatch" },
    ]);
    expect(result).toMatchObject({ received: 3, created: 2, rejectedCount: 5 });
    expect(db.all("SELECT external_id FROM sources ORDER BY external_id")).toEqual([
      { external_id: "ok-1" },
      { external_id: "ok-2" },
    ]);
    // the refused revoke changed nothing: the scope is the upsert's
    expect(db.all("SELECT access_scope FROM sources WHERE external_id = 'ok-1'")).toEqual([
      { access_scope: JSON.stringify(["group:team", "user:writer"]) },
    ]);
  });

  it("② a revoke line of a source with no live version is stale", async () => {
    const result = await imported(line({ external_id: "ghost", operation: "revoke" }));
    expect(counts(result)).toMatchObject({ received: 1, created: 0, stale: 1, rejectedCount: 0 });
    expect(state()).toMatchObject({ sources: 0, versions: 0, tombstones: 0 });
  });

  it("③ no refusal carries a value of a line: a canary in every position", async () => {
    const result = await imported(
      [
        line({ title: 7 as never, [CANARY]: CANARY }),
        `{"${CANARY}": `,
        line({ content: CANARY, content_hash: hashOf("x") }),
        line({ access_scope: [], title: CANARY }),
        line({ external_id: "c" }),
        line({ external_id: "c", operation: "revoke", content: CANARY, version: 2 }),
        line({ external_id: CANARY, version: 1, access_scope: [CANARY, ""] }),
      ].join("\n"),
    );
    expect(result.rejectedCount).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("④ a line over the per-line limit is refused and the next line is stored", async () => {
    const huge = line({ content: "x".repeat(1024 * 1024) });
    const result = await imported([huge, line({ external_id: "after" })].join("\n"));
    expect(result.rejected).toEqual([{ at: "line:1", code: "schema" }]);
    expect(result.created).toBe(1);
  });
});

describe("import.duplicate", () => {
  const FILE = [
    line({ external_id: "a" }), // live
    line({ external_id: "b" }), // live
    del("gone", 2), // never stored: a tombstone from the start
    line({ external_id: "lost", operation: "access-revoked", version: 2 }),
    line({ external_id: "b" }), // the same line twice in one file
  ].join("\n");
  const REVOKE = line({ external_id: "a", operation: "revoke", access_scope: ["user:writer"] });

  it("a file collector's second sync of the same file has no change and stores nothing", async () => {
    const m = await collector(fileOf([FILE, REVOKE].join("\n")));
    const first = await sync(m);
    expect(first).toMatchObject({ created: 2, scopeUpdated: 1, tombstoned: 2, unchanged: 1 });
    const before = state();
    const second = await sync(m);
    expect(second).toMatchObject({ received: 0, created: 0, rescanned: false });
    expect(state()).toEqual(before);
  });

  it("① to ④ the API again: every line unchanged, no source, version or tombstone more", async () => {
    const first = await imported(FILE);
    expect(counts(first)).toMatchObject({
      received: 5,
      created: 2,
      tombstoned: 2,
      unchanged: 1, // the second `b` line: in one file the second is unchanged
    });
    const scoped = await imported(REVOKE);
    expect(scoped).toMatchObject({ scopeUpdated: 1 });
    const before = state();
    const again = await imported(FILE.replace(line({ external_id: "a" }), "")); // the upsert of `a` would widen its scope again
    expect(counts(again)).toEqual({
      received: 4,
      created: 0,
      unchanged: 4, // the upsert, the delete and the access-revoked, and `b` again
      scopeUpdated: 0,
      stale: 0,
      staleTombstone: 0,
      blocked: 0,
      tombstoned: 0,
      rejectedCount: 0,
    });
    // ③ a revoke line again is a scope change that changes nothing
    expect(await imported(REVOKE)).toMatchObject({ unchanged: 1, scopeUpdated: 0 });
    expect(state()).toEqual(before);
  });

  it("the same revision with other content is a revision-conflict at its line", async () => {
    const result = await imported(
      [line(), line({ content: "another body" }), line({ external_id: "z" })].join("\n"),
    );
    expect(result.rejected).toEqual([{ at: "line:2", code: "revision-conflict" }]);
    expect(counts(result)).toMatchObject({ created: 2, unchanged: 0, rejectedCount: 1 });
  });
});

describe("import.out-of-order", () => {
  const v = (version: number, content = `v${version}`) => line({ version, content });

  it("① a lower revision after a higher one is stale: in a file, between files, and between a file and the API", async () => {
    const check = async (latest: string) => {
      expect(db.all("SELECT body, revision FROM source_versions ORDER BY version DESC")[0]).toEqual(
        {
          body: latest,
          revision: 2,
        },
      );
    };
    // in one file
    const one = await imported([v(2), v(1)].join("\n"), "one");
    expect(one).toMatchObject({ created: 1, stale: 1 });
    await check("v2");
    // between two files (a file collector, then another file)
    const m = await collector(fileOf(v(2), "a.jsonl"), "two");
    await m.sync("two");
    writeFileSync(join(dir, "a.jsonl"), [v(2), v(1)].join("\n"));
    expect(await m.sync("two")).toMatchObject({ rescanned: true, stale: 1, created: 0 });
    // between a file and the API
    const mixed = await collector(fileOf(v(2), "b.jsonl"), "three");
    await mixed.sync("three");
    expect(await imported(v(1), "three")).toMatchObject({ stale: 1, created: 0 });
    expect(db.all("SELECT count(*) AS n FROM source_versions")[0]?.n).toBe(3);
  });

  it("② after a deletion (revision 2) the revisions 1 and 2 are blocked, and a delete below the stored revision is counted", async () => {
    const first = await imported([v(1), del("a", 2)].join("\n"));
    expect(first).toMatchObject({ created: 1, tombstoned: 1 });
    const late = await imported([v(1), v(2)].join("\n"));
    expect(late).toMatchObject({ blocked: 2, created: 0, rejectedCount: 0 });
    // R11: a delete older than the revision the store holds is not applied, but shown
    const stored = await imported(line({ external_id: "k", version: 5, content: "k5" }), "inst");
    expect(stored.created).toBe(1);
    const stale = await imported(del("k", 3));
    expect(stale).toMatchObject({ staleTombstone: 1, tombstoned: 0 });
    expect(count("tombstones")).toBe(1);
  });

  it("③ a greater revision is a new version of the source", async () => {
    await imported([v(1), v(2)].join("\n"));
    const third = await imported(v(3));
    expect(third).toMatchObject({ created: 1 });
    expect(db.all("SELECT version, revision FROM source_versions ORDER BY version")).toEqual([
      { version: 1, revision: 1 },
      { version: 2, revision: 2 },
      { version: 3, revision: 3 },
    ]);
  });
});

describe("import.partial-failure", () => {
  const FAILING = [
    line({ external_id: "a" }),
    line({ external_id: "b" }),
    line({ external_id: "boom" }),
  ].join("\n");
  const failOnInsertOf = (externalId: string) =>
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON sources WHEN new.external_id = '${externalId}'
      BEGIN SELECT RAISE(ABORT, '${CANARY}'); END`);

  it("the API stores no line of a failed request, answers storage-failed and is the same once fixed", async () => {
    failOnInsertOf("boom");
    const errors: unknown[] = [];
    const outcome = await importContent(db, "inst", FAILING, { onError: (e) => errors.push(e) });
    expect(outcome).toEqual({ error: "storage-failed" });
    expect(errors).toHaveLength(1);
    expect(state()).toMatchObject({ sources: 0, versions: 0, jobs: 0 });
    db.exec("DROP TRIGGER boom");
    const clean = await imported(FAILING);
    const reference = await imported(FAILING, "reference");
    expect(noId(clean)).toEqual(noId(reference));
    expect(clean.created).toBe(3);
  });

  it("the lock is free after a failure, so the next import runs", async () => {
    failOnInsertOf("boom");
    expect(await importContent(db, "inst", FAILING)).toEqual({ error: "storage-failed" });
    db.exec("DROP TRIGGER boom");
    expect(await importContent(db, "inst", FAILING)).toMatchObject({ created: 3 });
  });

  it("a file collector's failed page stores none of its lines, keeps the cursor, and a retry is the clean result", async () => {
    const m = await collector(fileOf(FAILING));
    failOnInsertOf("boom");
    const failed = await sync(m);
    expect(failed).toMatchObject({ stopped: "storage-failed", created: 0 });
    expect(count("sources")).toBe(0);
    expect(readCursor(db, "file")).toBeNull();
    db.exec("DROP TRIGGER boom");
    expect(await m.sync("file")).toMatchObject({ created: 3, received: 3 });
  });
});

describe("import.identity", () => {
  it("① the golden mail's same-content mails of two instances stay two sources, each with its own scope, revision and provenance", async () => {
    const text = readFileSync(resolve(GOLDEN_DIR, "mail.jsonl"), "utf8");
    const result = await imported(text);
    expect(result.rejectedCount).toBe(0);
    const rows = db.all(
      `SELECT s.namespace, s.external_id, s.access_scope, v.revision, v.content_hash, v.meta
         FROM sources s JOIN source_versions v ON v.source_id = s.id
        WHERE s.namespace = 'conn-mail-02' OR s.external_id IN
          ('<s09-i1-mailA@mail.example.test>', '<s09-i4-mailA@mail.example.test>')`,
    );
    expect(rows).toHaveLength(4);
    const byHash = new Map<string, typeof rows>();
    for (const row of rows)
      byHash.set(row.content_hash as string, [
        ...(byHash.get(row.content_hash as string) ?? []),
        row,
      ]);
    expect([...byHash.values()].filter((g) => g.length === 2)).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.parse(row.access_scope as string)).toEqual(["org:all"]);
      expect(row.revision).toBe(1);
      expect(JSON.parse(row.meta as string)).toMatchObject({ sourceType: "mail" });
    }
    expect(new Set(rows.map((r) => r.namespace))).toEqual(
      new Set(["conn-mail-01", "conn-mail-02"]),
    );
  });

  it("② the same external id in two instances is two sources", async () => {
    await imported(line(), "first");
    await imported(line(), "second");
    expect(
      db.all("SELECT connector_instance_id AS i, external_id FROM sources ORDER BY i"),
    ).toEqual([
      { i: "first", external_id: "a" },
      { i: "second", external_id: "a" },
    ]);
  });

  it("the same external id in two namespaces of one instance is two sources", async () => {
    await imported([line(), line({ connector_instance_id: "conn-b" })].join("\n"));
    expect(db.all("SELECT namespace FROM sources ORDER BY namespace")).toEqual([
      { namespace: "conn-a" },
      { namespace: "conn-b" },
    ]);
  });
});

describe("import.golden", () => {
  const GOLDEN = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".jsonl"));
  const V02 = readdirSync(FIXTURES).filter((f) => /^v02-.*\.jsonl$/.test(f));

  it.each(GOLDEN)(
    "golden %s is imported with no refusal; deletes tombstone, revokes narrow the scope and keep the version",
    async (name) => {
      const text = readFileSync(resolve(GOLDEN_DIR, name), "utf8");
      const records = text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ImportRecord);
      const result = await imported(text);
      expect(result.rejected).toEqual([]);
      expect(result.received).toBe(records.length);
      const deletes = records.filter((r) => r.operation === "delete");
      const revokes = records.filter((r) => r.operation === "revoke");
      expect(deletes.length).toBeGreaterThan(0);
      expect(revokes.length).toBeGreaterThan(0);
      expect(result).toMatchObject({ tombstoned: deletes.length, scopeUpdated: revokes.length });
      expect(count("tombstones")).toBe(deletes.length);
      for (const r of deletes) {
        const key = identityKey(db, "inst", r.connector_instance_id, r.external_id);
        expect(db.all("SELECT count(*) AS n FROM sources WHERE external_id = ?", [key])[0]?.n).toBe(
          1,
        );
      }
      for (const r of revokes) {
        const row = db.all(
          `SELECT s.access_scope, (SELECT count(*) FROM source_versions v WHERE v.source_id = s.id) AS versions
           FROM sources s WHERE s.connector_instance_id = 'inst' AND s.namespace = ? AND s.external_id = ?`,
          [r.connector_instance_id, r.external_id],
        )[0];
        expect(JSON.parse(row?.access_scope as string)).toEqual([...r.access_scope].sort());
        // every earlier version stays and the revoke made none of its own
        const upserts = records.filter(
          (o) =>
            o.operation === "upsert" &&
            o.connector_instance_id === r.connector_instance_id &&
            o.external_id === r.external_id,
        );
        expect(row?.versions).toBe(upserts.length);
      }
    },
  );

  it.each(V02)("the V02 fixture %s is imported with no refusal", async (name) => {
    const text = readFileSync(resolve(FIXTURES, name), "utf8");
    const records = text.split("\n").filter((l) => l.trim());
    const result = await imported(text);
    expect(result.rejectedCount).toBe(0);
    expect(result.received).toBe(records.length);
  });

  it("every golden file and V02 fixture is imported by a file collector with no refusal too", async () => {
    for (const [i, path] of [
      ...GOLDEN.map((f) => resolve(GOLDEN_DIR, f)),
      ...V02.map((f) => resolve(FIXTURES, f)),
    ].entries()) {
      const m = await collector(path, `file-${i}`);
      const result = await sync(m, `file-${i}`);
      expect(result.rejectedCount).toBe(0);
      expect(result.stopped).toBeUndefined();
    }
  });
});

describe("import.revoke-switch", () => {
  it("② an access-revoked line tombstones the source with the reason access-revoked", async () => {
    await imported(line({ external_id: "a" }));
    const result = await imported(
      line({ external_id: "a", operation: "access-revoked", version: 2 }),
    );
    expect(result).toMatchObject({ tombstoned: 1 });
    expect(db.all("SELECT reason FROM tombstones")).toEqual([{ reason: "access-revoked" }]);
    expect(count("source_versions")).toBe(0);
  });

  it("a revoke line narrows the scope and keeps the version, where access-revoked would purge it", async () => {
    await imported(line({ external_id: "a" }));
    const result = await imported(
      line({ external_id: "a", operation: "revoke", version: 2, access_scope: ["user:writer"] }),
    );
    expect(result).toMatchObject({ scopeUpdated: 1, tombstoned: 0 });
    expect(count("tombstones")).toBe(0);
    expect(count("source_versions")).toBe(1);
    expect(db.all("SELECT access_scope FROM sources")).toEqual([
      { access_scope: JSON.stringify(["user:writer"]) },
    ]);
  });
});

describe("import.api", () => {
  it("① an instance registered as another kind is refused, and nothing is stored", async () => {
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('other', 'test-fixtures')");
    expect(await importContent(db, "other", line())).toEqual({ error: "bad-request" });
    expect(state()).toMatchObject({ sources: 0, versions: 0 });
  });

  it("① an instance taken by a sync or an import answers instance-busy and stores nothing; the lock is released after", async () => {
    const release = tryLockInstance(db, "inst");
    expect(release).toBeDefined();
    expect(await importContent(db, "inst", line())).toEqual({ error: "instance-busy" });
    expect(state()).toMatchObject({ sources: 0, versions: 0 });
    // another instance is free meanwhile
    expect(await importContent(db, "other-inst", line())).toMatchObject({ created: 1 });
    release?.();
    expect(await importContent(db, "inst", line())).toMatchObject({ created: 1 });
  });

  it("registers the instance as jsonl-import on its first import", async () => {
    await imported(line(), "fresh");
    expect(db.all("SELECT kind FROM connector_instances WHERE id = 'fresh'")).toEqual([
      { kind: JSONL_IMPORT_KIND },
    ]);
  });

  it("② the same JSONL through the file collector and the API gives the same counts and refusals", async () => {
    const text = [
      line({ external_id: "a" }),
      "{broken",
      line({ external_id: "a", operation: "revoke", access_scope: ["user:writer"] }),
      line({ external_id: "b", access_scope: [] }),
      line({ external_id: "a", operation: "revoke", content: "other", version: 2 }),
      line({ external_id: "c" }),
      line({ external_id: "c", content: "different" }),
      del("d", 3),
      line({ external_id: "e", content_hash: hashOf("no") }),
    ].join("\n");
    const viaApi = await imported(text, "api");
    const viaFile = await sync(await collector(fileOf(text), "file"));
    expect(viaApi.rejectedCount).toBeGreaterThanOrEqual(5);
    expect({ ...noId(viaApi), rejected: viaApi.rejected }).toEqual({
      ...noId(viaFile as SyncResponse),
      rejected: viaFile.rejected,
    });
    // the stored result is the same too
    const stored = (instance: string) =>
      db
        .all(
          `SELECT s.namespace, s.external_id, s.access_scope, s.scope_claimed, v.body, v.revision
           FROM sources s LEFT JOIN source_versions v ON v.source_id = s.id
          WHERE s.connector_instance_id = ? ORDER BY s.namespace, s.external_id, v.version`,
          [instance],
        )
        // a purged source's names are keyed hashes, which differ by instance
        .map((r) => ({
          ...r,
          namespace: /^[0-9a-f]{64}$/.test(String(r.namespace)) ? "<hashed>" : r.namespace,
          external_id: /^[0-9a-f]{64}$/.test(String(r.external_id)) ? "<hashed>" : r.external_id,
        }))
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    expect(stored("api")).toEqual(stored("file"));
    expect(stored("api").length).toBeGreaterThan(0);
  });

  it("R15: the scope of an imported source is marked as claimed, on both paths", async () => {
    await imported(line({ external_id: "x" }), "api");
    await (await collector(fileOf(line({ external_id: "x" })), "file")).sync("file");
    expect(
      db.all("SELECT connector_instance_id AS i, scope_claimed FROM sources ORDER BY i"),
    ).toEqual([
      { i: "api", scope_claimed: 1 },
      { i: "file", scope_claimed: 1 },
    ]);
  });

  it("an import wakes the runner once and notifies the projections of a new version only", async () => {
    const wakes: string[] = [];
    const notified: unknown[] = [];
    await importContent(db, "inst", [line(), del("gone", 2)].join("\n"), {
      runner: { wake: async () => void wakes.push("wake") },
      projections: { notify: (notices) => (notified.push(...notices), Promise.resolve()) },
    });
    expect(wakes).toEqual(["wake"]);
    expect(notified).toHaveLength(1);
  });

  it("wakes the runner only when the request registered jobs, and keeps no cursor (an import has none)", async () => {
    let wakes = 0;
    const runner = { wake: async () => void wakes++ };
    await importContent(db, "inst", line(), { runner });
    expect(wakes).toBe(1);
    // the same text again stores nothing: no job, no wake
    await importContent(db, "inst", line(), { runner });
    expect(wakes).toBe(1);
    expect(readCursor(db, "inst")).toBeNull();
  });

  it("surfaces every refusal and the staleTombstone count in its result, not only the stored", async () => {
    await imported(line({ version: 5 }));
    const result = await imported(
      [del("a", 3), "{broken", line({ content: "conflict", version: 5 })].join("\n"),
    );
    expect(result).toMatchObject({ staleTombstone: 1, rejectedCount: 2 });
    expect(result.rejected).toEqual([
      { at: "line:2", code: "invalid-json" },
      { at: "line:3", code: "revision-conflict" },
    ]);
  });
});

describe("sync.rescan ⑥: the file collector's edited file", () => {
  it("is rescanned, raises deletionsMayBeMissed (a removed line is no deletion), adding only what is new", async () => {
    const path = fileOf([line({ external_id: "a" }), line({ external_id: "b" })].join("\n"));
    const m = await collector(path);
    expect(await m.sync("file")).toMatchObject({ created: 2, rescanned: false });
    writeFileSync(
      path,
      [
        line({ external_id: "a" }),
        line({ external_id: "b" }),
        line({ external_id: "c" }),
        del("b", 2),
      ].join("\n"),
    );
    const second = await sync(m);
    expect(second).toMatchObject({
      rescanned: true,
      deletionsMayBeMissed: true,
      created: 1,
      unchanged: 2,
      tombstoned: 1,
    });
    expect(second.stopped).toBeUndefined();
    expect(m.list()[0]).toMatchObject({ deletionsMayBeMissed: true });
    // a source a line was removed for stays: only a delete line deletes
    writeFileSync(path, line({ external_id: "a" }));
    const third = await sync(m);
    expect(third).toMatchObject({ rescanned: true, created: 0 });
    expect(db.all("SELECT count(*) AS n FROM source_versions")[0]?.n).toBe(2);
  });

  it("a scope change of a revoke line keeps its content check through the sync's page envelope", async () => {
    const path = fileOf(
      [
        line({ external_id: "a" }),
        line({ external_id: "a", operation: "revoke", content: "not stored", version: 2 }),
      ].join("\n"),
    );
    const result = await sync(await collector(path));
    // the position is the line, through the page envelope as on the API
    expect(result.rejected).toEqual([{ at: "line:2", code: "scope-change-content-mismatch" }]);
  });
});

/**
 * One identity (I01-R22, T01 handoff 7): every route resolves a line as (instance, namespace = the
 * line's connector_instance_id, external id), the V02 screen route included. A source stored under the
 * old V02 identity (the line's connector_instance_id as the instance, namespace "") is found by the
 * lookup, whichever instance the API names.
 */
describe("import.legacy-identity", () => {
  const legacy = (text: string) => productImporter(db)(text);
  const E1 = line({ external_id: "e1", connector_instance_id: "ci" });
  const DEL1 = line({
    external_id: "e1",
    connector_instance_id: "ci",
    operation: "delete",
    content: "",
    version: 2,
  });
  const body = "Synthetic body";
  const seedRow = (target: SqlDriver) => {
    registerConnectorInstance(target, "ci", JSONL_IMPORT_KIND);
    saveSourceRecord(target, "ci", {
      namespace: "",
      externalId: "e1",
      title: "Synthetic title",
      body,
      revision: 1,
    });
  };
  const seedTombstone = (target: SqlDriver) =>
    canonicalTransaction(target, (tx) =>
      applyTombstone(tx, {
        identity: { connectorInstanceId: "ci", namespace: "", externalId: "e1" },
        reason: "source-deleted",
        lastRevision: 2,
        at: new Date().toISOString(),
      }),
    );
  const namespaces = () =>
    db.all("SELECT namespace FROM sources ORDER BY id").map((r) => r.namespace);

  it('the V02 route writes the line\'s connector_instance_id as the namespace, no new namespace ""', async () => {
    await legacy(E1);
    expect(namespaces()).toEqual(["ci"]);
  });

  it("(a) an API delete fences a V02 re-import of the same line", async () => {
    await imported(E1, "ci");
    await imported(DEL1, "ci");
    const result = await legacy(E1);
    expect(result).toMatchObject({ created: 0 });
    expect(count("source_versions")).toBe(0);
    expect(count("sources")).toBe(1);
  });

  it("(b) an API import then a V02 import of the same line is one source", async () => {
    await imported(E1, "ci");
    await legacy(E1);
    expect(count("sources")).toBe(1);
    expect(count("source_versions")).toBe(1);
  });

  it("(c) a legacy row is updated in place by the V02 route, by the API and by the collector", async () => {
    seedRow(db);
    await legacy(E1);
    await imported(E1, "ci");
    await sync(await collector(fileOf(E1), "ci"), "ci");
    expect(count("sources")).toBe(1);
    expect(count("source_versions")).toBe(1);
    expect(namespaces()).toEqual([""]);
    await legacy(
      line({ external_id: "e1", connector_instance_id: "ci", version: 2, content: "v2" }),
    );
    expect(count("sources")).toBe(1);
    expect(count("source_versions")).toBe(2);
  });

  it("a legacy tombstone fences every route, and no body comes back", async () => {
    seedRow(db);
    seedTombstone(db);
    expect(count("source_versions")).toBe(0);
    await legacy(E1);
    await imported(E1, "ci");
    await sync(await collector(fileOf(E1), "ci"), "ci");
    expect(count("source_versions")).toBe(0);
    expect(count("sources")).toBe(1);
  });

  it("S1: the lookup is by the line's connector_instance_id, whichever instance the API names", async () => {
    seedRow(db);
    seedTombstone(db);
    const result = await imported(E1, "other");
    expect(result).toMatchObject({ created: 0, blocked: 1 });
    expect(count("source_versions")).toBe(0);
    expect(db.all("SELECT connector_instance_id AS i FROM sources")).toEqual([{ i: "ci" }]);
  });

  it("a source in the line's own namespace is judged where it is, though a legacy twin exists", async () => {
    await imported(E1, "ci"); // (ci, "ci")
    seedRow(db); // a twin from before
    expect(await imported(E1, "ci")).toMatchObject({ unchanged: 1, created: 0 });
    expect(count("source_versions")).toBe(2);
  });

  describe("(d) no ordering of the routes leaves two sources, or a body beside a tombstone", () => {
    const OPS = (["v02", "api", "file"] as const).flatMap((route) =>
      (["up", "del"] as const).map((kind) => ({ route, kind })),
    );
    const sequences = OPS.flatMap((x) => OPS.flatMap((y) => OPS.map((z) => [x, y, z])));

    it.each(["none", "row", "row+tombstone"] as const)(
      "seed %s, every ordering of three operations",
      async (seed) => {
        for (const [n, ops] of sequences.entries()) {
          const target = openCanonicalDb(join(dir, `p-${seed}-${n}`));
          try {
            if (seed !== "none") seedRow(target);
            if (seed === "row+tombstone") seedTombstone(target);
            for (const { route, kind } of ops) {
              const text = kind === "up" ? E1 : DEL1;
              if (route === "v02") await productImporter(target)(text);
              else if (route === "api") await importContent(target, "ci", text);
              else {
                const m = await createConnectorManager(
                  target,
                  [
                    {
                      id: "ci",
                      kind: JSONL_IMPORT_KIND,
                      config: { path: fileOf(text, `f-${seed}-${n}.jsonl`) },
                    },
                  ],
                  { [JSONL_IMPORT_KIND]: createJsonlConnector },
                );
                await m.sync("ci");
              }
            }
            const where = `${seed} ${JSON.stringify(ops)}`;
            const sources = target.all("SELECT count(*) AS n FROM sources")[0]?.n;
            const versions = target.all("SELECT count(*) AS n FROM source_versions")[0]?.n;
            const deleted = seed === "row+tombstone" || ops.some((o) => o.kind === "del");
            expect([where, sources]).toEqual([where, 1]);
            expect([where, versions]).toEqual([where, deleted ? 0 : 1]);
          } finally {
            target.close();
          }
        }
      },
      600_000,
    );
  });
});

describe("import.hardening (review A2, A3, W2)", () => {
  const nested = (depth: number) =>
    JSON.parse(`${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`) as Record<string, unknown>;

  it("A2: a deeply nested metadata line is refused as schema and the other lines are stored", async () => {
    const result = await imported(
      [
        line({ external_id: "ok" }),
        line({ external_id: "deep", metadata: nested(1000) }),
        line({ external_id: "ok2" }),
      ].join("\n"),
    );
    expect(result.rejected).toEqual([{ at: "line:2", code: "schema" }]);
    expect(result.created).toBe(2);
  });

  it("A2: the file collector's cursor passes the deep line", async () => {
    const path = fileOf(
      [line({ external_id: "ok" }), line({ external_id: "deep", metadata: nested(1000) })].join(
        "\n",
      ),
    );
    const m = await collector(path);
    const first = await sync(m);
    expect(first).toMatchObject({ created: 1 });
    expect(first.stopped).toBeUndefined();
    expect(first.rejected).toEqual([{ at: "line:2", code: "schema" }]);
    expect(readCursor(db, "file")).not.toBeNull();
    expect(await sync(m)).toMatchObject({ received: 0 });
  });

  it("A3: an id of a configured connector of another kind is refused, and stays unbound", async () => {
    const reserved = { list: () => [{ id: "site-x", kind: "site-mail", state: "ready" as const }] };
    expect(await importContent(db, "site-x", "", { connectors: reserved })).toEqual({
      error: "bad-request",
    });
    expect(db.all("SELECT id FROM connector_instances WHERE id = 'site-x'")).toEqual([]);
    expect(await importContent(db, "other-id", line(), { connectors: reserved })).toMatchObject({
      created: 1,
    });
  });

  it("W2: a scope change that reaches the store without its note is refused as schema, not stored unchecked", async () => {
    await imported(line({ external_id: "a" }));
    const { lines } = parseJsonl(
      line({
        external_id: "a",
        operation: "revoke",
        content: "other",
        version: 2,
        access_scope: ["user:writer"],
      }),
    );
    const change = lines[0]?.change as object;
    const copy = JSON.parse(JSON.stringify(change)); // a copied object has lost the note
    const result = storePage(
      {
        db,
        instanceId: "inst",
        kind: JSONL_IMPORT_KIND,
        capabilities: JSONL_CAPABILITIES,
        options: {},
      },
      { changes: [copy], rejected: [], nextCursor: null, endsRescan: false },
    );
    expect(result).toMatchObject({ rejected: [{ at: "change:0", code: "schema" }] });
    expect(db.all("SELECT access_scope FROM sources")).toEqual([
      { access_scope: JSON.stringify(["group:team", "user:writer"]) },
    ]);
  });
});
