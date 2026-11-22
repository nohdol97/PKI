// V02-R2, R4 and C3 `reimport.idempotent` integration: importing the V02 fixtures
// into a real SQLite file stores each line as a source version, raises the change
// sequence and registers its extraction job in one transaction; importing the same
// JSONL again changes no count; a greater revision is a new version beside the old;
// a line the store refuses is reported by its number without aborting the rest.
import type { ImportLineError, ImportRecord } from "@pki/contracts";
import { identityKey, readChangeSeq, writeTombstone, type SqlDriver } from "@pki/storage";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { CANONICAL_DB_FILE, openCanonicalDb, productImporter } from "./composition.ts";
import { EXTRACT_JOB_KIND, type SyncOptions } from "./connectors.ts";
import { createJsonlConnector } from "./adapters/jsonl-connector.ts";
import {
  IMPORT_ERROR_LIMIT,
  importJsonl as importJsonlWith,
  JSONL_CONNECTOR_KIND,
  MAX_IMPORT_INSTANCES,
} from "./jsonl-import.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
const GOLDEN_DIR = resolve(import.meta.dirname, "../../eval/golden/sources");
const GOLDEN = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".jsonl"));
const PLAIN = ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl"].map(fixture);

let dir: string;
let db: SqlDriver;
/** The product's importer: the composition point's JSONL Connector. */
const importJsonl = (target: SqlDriver, text: string, options: Pick<SyncOptions, "runner"> = {}) =>
  productImporter(target, options)(text);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-import-"));
  db = openCanonicalDb(join(dir, "data"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;
const counts = () => ({
  sources: count("sources"),
  versions: count("source_versions"),
  jobs: count("jobs"),
  changeSeq: readChangeSeq(db),
});

/** A whole answer: every error is listed below the cap, so the count is their number. */
const reply = (r: { received: number; created: number; errors: ImportLineError[] }) => ({
  ...r,
  errorCount: r.errors.length,
});

const MAIL = JSON.parse(PLAIN[0]?.trim() as string) as ImportRecord;
const hashOf = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const line = (patch: Partial<ImportRecord> = {}) => {
  const record = { ...MAIL, ...patch };
  return JSON.stringify({ ...record, content_hash: hashOf(record.content) });
};

describe("importJsonl", () => {
  it("stores the three fixtures under their own instances with one queued extraction job each", async () => {
    const before = counts();
    let received = 0;
    for (const text of PLAIN) {
      const result = await importJsonl(db, text);
      expect(result).toEqual(reply({ received: 1, created: 1, errors: [] }));
      received += result.received;
    }
    expect(received).toBe(3);
    expect(counts()).toEqual({
      sources: 3,
      versions: 3,
      jobs: 3,
      changeSeq: before.changeSeq + 3,
    });
    expect(db.all("SELECT id, kind FROM connector_instances ORDER BY id")).toEqual([
      { id: "conn-v02-chat", kind: JSONL_CONNECTOR_KIND },
      { id: "conn-v02-mail", kind: JSONL_CONNECTOR_KIND },
      { id: "conn-v02-wiki", kind: JSONL_CONNECTOR_KIND },
    ]);
    expect(
      db.all(
        `SELECT j.kind, j.status, j.fence_version, v.version, v.revision
           FROM jobs j JOIN source_versions v
             ON v.source_id = j.source_id AND v.version = j.fence_version`,
      ),
    ).toEqual(
      Array(3).fill({
        kind: EXTRACT_JOB_KIND,
        status: "queued",
        fence_version: 1,
        version: 1,
        revision: 1,
      }),
    );
  });

  it("changes no count when the same JSONL is imported again (C3 reimport.idempotent)", async () => {
    const text = [...PLAIN, fixture("v02-malicious.jsonl")].join("\n");
    expect(await importJsonl(db, text)).toEqual(reply({ received: 6, created: 6, errors: [] }));
    const once = counts();
    expect(await importJsonl(db, text)).toEqual(reply({ received: 6, created: 0, errors: [] }));
    expect(counts()).toEqual(once);
  });

  it("adds a new product version for a greater revision with other content and keeps the old one", async () => {
    await importJsonl(db, line());
    expect(await importJsonl(db, line({ version: 4, content: "수정된 합성 본문" }))).toEqual(
      reply({
        received: 1,
        created: 1,
        errors: [],
      }),
    );
    expect(
      db
        .all("SELECT version, revision, body FROM source_versions ORDER BY id")
        .map((r) => [r.version, r.revision, r.body === MAIL.content]),
    ).toEqual([
      [1, 1, true],
      [2, 4, false],
    ]);
    expect(db.all("SELECT fence_version FROM jobs ORDER BY id")).toEqual([
      { fence_version: 1 },
      { fence_version: 2 },
    ]);
  });

  it("takes a lower revision as stale, whatever its content: no error, nothing stored, the other lines stored (I01-R10)", async () => {
    await importJsonl(db, line({ version: 3, content: "v3" }));
    const before = counts();
    const result = await importJsonl(
      db,
      [
        line({ external_id: "fresh", content: "새 원본" }),
        line({ version: 2, content: "v2" }),
      ].join("\n"),
    );
    expect(result).toEqual(reply({ received: 2, created: 1, errors: [] }));
    expect(counts()).toEqual({
      ...before,
      sources: before.sources + 1,
      versions: before.versions + 1,
      jobs: before.jobs + 1,
      changeSeq: before.changeSeq + 1,
    });
  });

  it("reports malformed lines with the valid ones stored", async () => {
    const result = await importJsonl(
      db,
      ["{", line(), line({ content: "x", version: 0 })].join("\n"),
    );
    expect(result).toEqual(
      reply({
        received: 1,
        created: 1,
        errors: [
          { line: 1, reason: "invalid-json" },
          { line: 3, reason: "invalid-record", field: "version" },
        ],
      }),
    );
  });

  // Provisional (T04): a source the tombstone blocks is a line error, not a failed import.
  it("reports a re-imported record the tombstone blocks as a line error, storing the other lines", async () => {
    await importJsonl(db, line({ content: "v1" }));
    writeTombstone(db, {
      sourceId: 1,
      version: 1,
      at: "2026-11-21T00:00:00Z",
      reason: "source-deleted",
    });
    db.run("DELETE FROM source_versions WHERE source_id = 1");
    const result = await importJsonl(
      db,
      [line({ version: 2, content: "v2" }), line({ external_id: "other", content: "다른" })].join(
        "\n",
      ),
    );
    expect(result).toEqual(
      reply({
        received: 2,
        created: 1,
        errors: [{ line: 1, reason: "tombstoned" }],
      }),
    );
    expect(db.all("SELECT source_id FROM source_versions")).toEqual([{ source_id: 2 }]);
  });

  it("purges a source on its delete line and tombstones a source never stored on its delete or revoke line (I01-R11)", async () => {
    await importJsonl(db, line({ external_id: "d" }));
    const result = await importJsonl(
      db,
      [
        line({ external_id: "d", operation: "delete", content: "", version: 2 }),
        line({ external_id: "never", operation: "delete", content: "" }),
        line({ external_id: "r", operation: "revoke" }),
        line({ external_id: "u" }),
      ].join("\n"),
    );
    expect(result).toEqual(reply({ received: 4, created: 1, errors: [] }));
    expect(
      db.all(
        "SELECT s.external_id, t.covers_version AS version, t.reason FROM tombstones t JOIN sources s ON s.id = t.source_id ORDER BY t.source_id",
      ),
      // a purged source's identifier is the keyed hash, no longer "d" (I04-R7); a
      // source never seen is a hashed row from the start, covering version 0
    ).toEqual([
      {
        external_id: identityKey(db, MAIL.connector_instance_id, "", "d"),
        version: 1,
        reason: "source-deleted",
      },
      {
        external_id: identityKey(db, MAIL.connector_instance_id, "", "never"),
        version: 0,
        reason: "source-deleted",
      },
      {
        external_id: identityKey(db, MAIL.connector_instance_id, "", "r"),
        version: 0,
        reason: "access-revoked",
      },
    ]);
    expect(
      db.all("SELECT s.external_id FROM source_versions v JOIN sources s ON s.id = v.source_id"),
    ).toEqual([{ external_id: "u" }]);
  });

  it("keeps per-source line order across a delete between two upserts in one file", async () => {
    // rounds: v1 is stored, the delete (revision 2) purges it, revision 3 is a new version past the cover
    const result = await importJsonl(
      db,
      [
        line({ content: "v1" }),
        line({ operation: "delete", content: "", version: 2 }),
        line({ version: 3, content: "v3" }),
        line({ external_id: "other" }),
      ].join("\n"),
    );
    expect(result).toEqual(reply({ received: 4, created: 3, errors: [] }));
    expect(db.all("SELECT covers_version AS version, reason FROM tombstones")).toEqual([
      { version: 1, reason: "source-deleted" },
    ]);
    expect(
      db.all(
        "SELECT s.external_id, v.version FROM source_versions v JOIN sources s ON s.id = v.source_id ORDER BY v.id",
      ),
    ).toEqual([
      { external_id: "other", version: 1 },
      { external_id: MAIL.external_id, version: 2 },
    ]);
    // importing it again: the tombstone is still there (nobody lifted it), so
    // revision 1, not above the delete's, is blocked; the delete is below what is
    // held (stale-tombstone, not applied); revision 3 and the other line are unchanged
    const again = await importJsonl(
      db,
      [
        line({ content: "v1" }),
        line({ operation: "delete", content: "", version: 2 }),
        line({ version: 3, content: "v3" }),
        line({ external_id: "other" }),
      ].join("\n"),
    );
    expect(again).toEqual(
      reply({ received: 4, created: 0, errors: [{ line: 1, reason: "tombstoned" }] }),
    );
    expect(count("source_versions")).toBe(2);
  });

  it("refuses the lines of an instance already bound to another Connector kind", async () => {
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('site-mail', 'site-mail')");
    const result = await importJsonl(
      db,
      [line({ connector_instance_id: "site-mail" }), line({ external_id: "ok" })].join("\n"),
    );
    expect(result).toEqual(
      reply({
        received: 1,
        created: 1,
        errors: [{ line: 1, reason: "instance-conflict" }],
      }),
    );
    expect(db.all("SELECT kind FROM connector_instances WHERE id = 'site-mail'")).toEqual([
      { kind: "site-mail" },
    ]);
  });

  it("stores v1 and v2 of one source in one file as two versions with two jobs (R2, review A-M1)", async () => {
    const result = await importJsonl(
      db,
      [line({ content: "v1" }), line({ version: 2, content: "v2" })].join("\n"),
    );
    expect(result).toEqual(reply({ received: 2, created: 2, errors: [] }));
    expect(db.all("SELECT version, revision, body FROM source_versions ORDER BY id")).toEqual([
      { version: 1, revision: 1, body: "v1" },
      { version: 2, revision: 2, body: "v2" },
    ]);
    expect(db.all("SELECT fence_version FROM jobs ORDER BY id")).toEqual([
      { fence_version: 1 },
      { fence_version: 2 },
    ]);
  });

  it.each(GOLDEN)(
    "stores, deletes or reports every line of golden %s (no silent drop)",
    async (name) => {
      const text = readFileSync(resolve(GOLDEN_DIR, name), "utf8");
      const records = text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ImportRecord);
      const deletions = records.filter((r) => r.operation !== "upsert").length;
      const result = await importJsonl(db, text);
      expect(deletions).toBeGreaterThan(0);
      expect(result.received).toBe(records.length);
      expect(result.created + deletions + result.errorCount).toBe(records.length);
      expect(result.errors).toEqual([]);
      // each delete and revoke tombstoned a source the file had stored, and purged it
      expect(count("tombstones")).toBe(deletions);
      expect(count("jobs")).toBe(result.created);
      expect(count("source_versions")).toBeLessThan(result.created);
    },
  );

  it("refuses the lines of instances past the cap per file, registering none of them", async () => {
    const text = Array.from({ length: MAX_IMPORT_INSTANCES + 2 }, (_, i) =>
      line({ connector_instance_id: `conn-${i}`, external_id: `e-${i}` }),
    ).join("\n");
    const result = await importJsonl(db, text);
    expect(result).toEqual(
      reply({
        received: MAX_IMPORT_INSTANCES,
        created: MAX_IMPORT_INSTANCES,
        errors: [
          { line: MAX_IMPORT_INSTANCES + 1, reason: "too-many-instances" },
          { line: MAX_IMPORT_INSTANCES + 2, reason: "too-many-instances" },
        ],
      }),
    );
    expect(count("connector_instances")).toBe(MAX_IMPORT_INSTANCES);
  });

  it("lists the first errors only, with the total count (review B-S1)", async () => {
    const result = await importJsonl(
      db,
      Array(IMPORT_ERROR_LIMIT + 50)
        .fill("{")
        .join("\n"),
    );
    expect(result.errorCount).toBe(IMPORT_ERROR_LIMIT + 50);
    expect(result.errors).toHaveLength(IMPORT_ERROR_LIMIT);
    expect(result.errors.at(-1)).toEqual({ line: IMPORT_ERROR_LIMIT, reason: "invalid-json" });
  });

  it("reports a job registration conflict as that instance's failure, keeping the instance before it", async () => {
    db.run(`INSERT INTO connector_instances (id, kind) VALUES (?, ?)`, [
      MAIL.connector_instance_id,
      JSONL_CONNECTOR_KIND,
    ]);
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES (?, '', ?)",
      [MAIL.connector_instance_id, MAIL.external_id],
    );
    db.run(
      `INSERT INTO jobs (kind, source_id, fence_version, status, run_after, fairness_key,
         registered_change_seq, created_at, updated_at)
       VALUES (?, 1, 1, 'succeeded', 0, 'f', 0, 0, 0)`,
      [EXTRACT_JOB_KIND],
    );
    const before = counts();
    const result = await importJsonl(
      db,
      [line({ connector_instance_id: "conn-first", external_id: "a" }), line()].join("\n"),
    );
    // the conflict is not a registration: the mail instance's page is rolled back
    expect(result).toEqual(
      reply({ received: 1, created: 1, errors: [{ line: 2, reason: "instance-failed" }] }),
    );
    expect(counts()).toEqual({
      sources: before.sources + 1,
      versions: before.versions + 1,
      jobs: before.jobs + 1,
      changeSeq: before.changeSeq + 1,
    });
  });

  it("reports an instance bound to another kind during the import as instance-conflict (review B-S2)", async () => {
    const racing = () => {
      const connector = createJsonlConnector();
      return {
        ...connector,
        initialize: async (config: unknown) => {
          db.run("INSERT INTO connector_instances (id, kind) VALUES (?, 'test-fixtures')", [
            MAIL.connector_instance_id,
          ]);
          return connector.initialize(config);
        },
      };
    };
    const result = await importJsonlWith(db, line(), { createConnector: racing });
    expect(result).toEqual(
      reply({ received: 0, created: 0, errors: [{ line: 1, reason: "instance-conflict" }] }),
    );
    expect(count("source_versions")).toBe(0);
  });

  it("wakes the runner once the page with new jobs is committed, and not for unchanged input", async () => {
    // another connection sees only committed rows
    const reader = openBetterSqlite3(join(dir, "data", CANONICAL_DB_FILE));
    const committedJobs: unknown[] = [];
    const wake = vi.fn(async () => {
      committedJobs.push(reader.all("SELECT count(*) AS n FROM jobs")[0]?.n);
    });
    await importJsonl(db, line(), { runner: { wake } });
    expect(wake).toHaveBeenCalledTimes(1);
    await importJsonl(db, line(), { runner: { wake } });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(committedJobs).toEqual([1]);
    reader.close();
  });
});

describe("importJsonl, review round 2", () => {
  /** Plants the job the first version of `external_id` would register, so its page fails. */
  const plantJobConflict = (externalId: string) => {
    db.run("INSERT INTO connector_instances (id, kind) VALUES (?, ?) ON CONFLICT DO NOTHING", [
      MAIL.connector_instance_id,
      JSONL_CONNECTOR_KIND,
    ]);
    const { lastInsertRowid } = db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES (?, '', ?)",
      [MAIL.connector_instance_id, externalId],
    );
    db.run(
      `INSERT INTO jobs (kind, source_id, fence_version, status, run_after, fairness_key,
         registered_change_seq, created_at, updated_at)
       VALUES (?, ?, 1, 'succeeded', 0, 'f', 0, 0, 0)`,
      [EXTRACT_JOB_KIND, lastInsertRowid],
    );
  };

  it("keeps page 1 of a round and reports only page 2's lines when page 2 fails (A7)", async () => {
    plantJobConflict("s120");
    const before = counts();
    const text = Array.from({ length: 150 }, (_, i) =>
      line({ external_id: `s${i + 1}`, content: `c${i + 1}` }),
    ).join("\n");
    const result = await importJsonl(db, text);
    expect(result.received).toBe(100);
    expect(result.created).toBe(100);
    expect(result.errorCount).toBe(50);
    expect(result.errors).toEqual(
      Array.from({ length: 50 }, (_, i) => ({ line: 101 + i, reason: "instance-failed" })),
    );
    expect(counts()).toEqual({
      sources: before.sources + 100, // page 2's new source rows went with its rollback
      versions: before.versions + 100,
      jobs: before.jobs + 100,
      changeSeq: before.changeSeq + 100,
    });
    expect(
      db.all(
        "SELECT max(CAST(substr(s.external_id, 2) AS INTEGER)) AS n FROM source_versions v JOIN sources s ON s.id = v.source_id",
      ),
    ).toEqual([{ n: 100 }]);
  });

  it("hands a failure to onError, and the product logs only its error class (A8)", async () => {
    plantJobConflict(MAIL.external_id);
    const seen: unknown[] = [];
    const result = await importJsonlWith(db, line(), {
      createConnector: createJsonlConnector,
      onError: (error) => seen.push(error),
    });
    expect(result.errors).toEqual([{ line: 1, reason: "instance-failed" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Error);

    const logged: [string, unknown][] = [];
    await productImporter(db, { logger: (event, fields) => logged.push([event, fields]) })(line());
    expect(logged).toEqual([["import-instance-failed", { error: "Error" }]]);
    // the message names the instance and the source; none of it is logged
    expect(JSON.stringify(logged)).not.toContain(MAIL.connector_instance_id);
  });

  it("lists the lowest line numbers first whatever stage refused them (A9)", async () => {
    // the store refuses line 1 after the parser refused lines 2..(LIMIT + 2)
    await importJsonl(db, line());
    const text = [line({ content: "다른 내용" }), ...Array(IMPORT_ERROR_LIMIT + 1).fill("{")].join(
      "\n",
    );
    const result = await importJsonl(db, text);
    expect(result.errorCount).toBe(IMPORT_ERROR_LIMIT + 2);
    expect(result.errors[0]).toEqual({ line: 1, reason: "revision-not-newer" });
    expect(result.errors.map((e) => e.line)).toEqual(
      Array.from({ length: IMPORT_ERROR_LIMIT }, (_, i) => i + 1),
    );
  });

  it("re-imports a file with several versions of one source as unchanged, with no error (B-R2-S1, C3)", async () => {
    const text = [
      line({ content: "v1" }),
      line({ version: 2, content: "v2" }),
      line({ version: 3, content: "v3" }),
      line({ external_id: "solo", content: "solo" }),
    ].join("\n");
    expect(await importJsonl(db, text)).toEqual(reply({ received: 4, created: 4, errors: [] }));
    const once = counts();
    expect(await importJsonl(db, text)).toEqual(reply({ received: 4, created: 0, errors: [] }));
    expect(counts()).toEqual(once);
  });

  it("stores a newer revision going back to an older content as a new version with its job (A11)", async () => {
    const text = [
      line({ content: "x" }),
      line({ version: 2, content: "y" }),
      line({ version: 3, content: "x" }),
    ].join("\n");
    expect(await importJsonl(db, text)).toEqual(reply({ received: 3, created: 3, errors: [] }));
    expect(db.all("SELECT version, revision, body FROM source_versions ORDER BY id")).toEqual([
      { version: 1, revision: 1, body: "x" },
      { version: 2, revision: 2, body: "y" },
      { version: 3, revision: 3, body: "x" },
    ]);
    expect(db.all("SELECT fence_version FROM jobs ORDER BY id")).toEqual([
      { fence_version: 1 },
      { fence_version: 2 },
      { fence_version: 3 },
    ]);
  });

  it.each(GOLDEN)("re-imports golden %s storing nothing and refusing nothing new", async (name) => {
    const text = readFileSync(resolve(GOLDEN_DIR, name), "utf8");
    const first = await importJsonl(db, text);
    const once = counts();
    const second = await importJsonl(db, text);
    expect(second.created).toBe(0);
    expect(first.errors).toEqual([]);
    // the lines of a source the first import deleted are refused now; nothing else
    expect(second.errors.length).toBeGreaterThan(0);
    expect(second.errors.every((e) => e.reason === "tombstoned")).toBe(true);
    expect(counts()).toEqual(once);
  });
});
