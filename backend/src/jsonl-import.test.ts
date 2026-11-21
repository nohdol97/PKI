// V02-R2, R4 and C3 `reimport.idempotent` integration: importing the V02 fixtures
// into a real SQLite file stores each line as a source version, raises the change
// sequence and registers its extraction job in one transaction; importing the same
// JSONL again changes no count; a greater revision is a new version beside the old;
// a line the store refuses is reported by its number without aborting the rest.
import type { ImportLineError, ImportRecord } from "@pki/contracts";
import { readChangeSeq, writeTombstone, type SqlDriver } from "@pki/storage";
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

  it("reports by line number a lower revision with other content, storing the other lines", async () => {
    await importJsonl(db, line({ version: 3, content: "v3" }));
    const before = counts();
    const result = await importJsonl(
      db,
      [
        line({ external_id: "fresh", content: "새 원본" }),
        line({ version: 2, content: "v2" }),
      ].join("\n"),
    );
    expect(result).toEqual(
      reply({
        received: 2,
        created: 1,
        errors: [{ line: 2, reason: "revision-not-newer" }],
      }),
    );
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
    writeTombstone(db, { sourceId: 1, version: 1, at: "2026-11-21T00:00:00Z", reason: "deleted" });
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

  // Provisional until V02-T08 implements deletion: refused per line, nothing stored for it.
  it("reports delete and revoke lines as not yet supported, storing the other lines", async () => {
    const result = await importJsonl(
      db,
      [
        line({ external_id: "d", operation: "delete", content: "" }),
        line({ external_id: "r", operation: "revoke" }),
        line({ external_id: "u" }),
      ].join("\n"),
    );
    expect(result).toEqual(
      reply({
        received: 3,
        created: 1,
        errors: [
          { line: 1, reason: "change-kind-unsupported" },
          { line: 2, reason: "change-kind-unsupported" },
        ],
      }),
    );
    expect(count("tombstones")).toBe(0);
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

  it.each(GOLDEN)("stores or reports every line of golden %s (no silent drop)", async (name) => {
    const text = readFileSync(resolve(GOLDEN_DIR, name), "utf8");
    const lines = text.split("\n").filter((l) => l.trim()).length;
    const result = await importJsonl(db, text);
    expect(result.created + result.errorCount).toBe(lines);
    // the only lines not stored are deletes and revokes, until V02-T08
    expect(new Set(result.errors.map((e) => e.reason))).toEqual(
      new Set(["change-kind-unsupported"]),
    );
    expect([count("source_versions"), count("jobs")]).toEqual([result.created, result.created]);
  });

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
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES (?, ?)", [
      MAIL.connector_instance_id,
      MAIL.external_id,
    ]);
    db.run(`INSERT INTO jobs (kind, source_id, fence_version, status) VALUES (?, 1, 1, 'done')`, [
      EXTRACT_JOB_KIND,
    ]);
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
