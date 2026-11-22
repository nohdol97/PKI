// delete.purge and delete.propagate (V02-C3, R12) through the product's pieces on a
// real SQLite file: a source deleted or revoked through its Connector change is
// tombstoned without content and purged in every version, so none of its text is
// left in the database file or its side files, an old version's value included;
// knowledge another source supports stays; the Insight is resolved or deleted
// with its item; a job leased or queued before the purge never writes; the
// source cannot come back at or below its tombstone.
import type { ChangeSet, Connector, StructuredRequest } from "@pki/contracts";
import { deleteSource } from "@pki/knowledge-engine";
import { DEFAULT_PROVIDER_SETTING, type EgressControls } from "@pki/providers";
import { findSourceId, readTombstone, writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider, fixtureExtraction } from "@pki/testkit";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_DB_FILE,
  openCanonicalDb,
  productCalls,
  productEgress,
  productImporter,
  productRunner,
} from "./composition.ts";
import { syncConnector } from "./connectors.ts";
import type { JobRunner } from "./job-runner.ts";
import { JSONL_CONNECTOR_KIND } from "./jsonl-import.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8").trim();
const MAIL = JSON.parse(read("v02-mail.jsonl")) as Record<string, unknown>;

/** A JSONL line on the mail fixture's shape, with its content hash. */
function jsonl(patch: Record<string, unknown>): string {
  const record = { ...MAIL, ...patch };
  const content = record.content as string;
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  return JSON.stringify({ ...record, content_hash: `sha256:${hash}` });
}

// Canaries share no prefix with each other or with any other word stored, so
// finding none is evidence that none is left (FTS stores shared prefixes once).
const CANARY = {
  title: "kvztitle",
  body: "jwxbody",
  quote: "pqyquote",
  name: "xfgname", // Y's name, only in source K: in items and the Insight's summary
  old: "mbvold", // only in K's version 1, and the quote of its superseded fact
};
const Y_NAME = `${CANARY.name} 시스템`;
const DEPENDS = `미리내 프로젝트는 ${Y_NAME}에 의존한다`;
const COMPLETION = new RegExp(`(\\w+) 기준 ${Y_NAME} 완료는 (\\d{4}-\\d{2}-\\d{2})`);
const K = { connector_instance_id: "conn-k", external_id: "k", id: "k-0001" };
// review B1: a new item named only by K, the subject of a relation on X
const ORPHAN_NAME = "orphcanary 엔진";
const ORPHAN_DEPENDS = `${ORPHAN_NAME}은 미리내 프로젝트에 의존한다`;
const kVersion = (revision: number, marker: string, date: string) =>
  jsonl({
    ...K,
    version: revision,
    title: `${CANARY.title} 일정`,
    content: `합성 자료. ${CANARY.body} 메모. ${marker} 기준 ${Y_NAME} 완료는 ${date}입니다. ${DEPENDS}.`,
  });

/**
 * The per-fixture double; for K, Y's completion date and X's dependency on Y with
 * their quotes, X and Y picked from the request's candidates when there.
 * `during` runs inside the Provider call, between the lease and the write.
 */
function answer(hooks: { during?: ((request: StructuredRequest) => void) | undefined }) {
  const fixture = fixtureExtraction();
  return (request: StructuredRequest): unknown => {
    hooks.during?.(request);
    const body = request.input.untrustedDocuments[0]?.body ?? "";
    const pick = (name: string) => request.input.candidates.find((c) => c.name === name)?.id;
    if (body.includes(ORPHAN_DEPENDS)) {
      // one relation: a new subject Z on candidate X
      return {
        items: [
          { ref: "Z", type: "System", name: ORPHAN_NAME, existingItemId: null },
          {
            ref: "X",
            type: "Project",
            name: "미리내 프로젝트",
            existingItemId: pick("미리내 프로젝트") ?? null,
          },
        ],
        facts: [],
        relations: [{ subject: "Z", type: "DEPENDS_ON", object: "X", quote: ORPHAN_DEPENDS }],
      };
    }
    const match = COMPLETION.exec(body);
    if (!match) return fixture(request);
    return {
      items: [
        {
          ref: "X",
          type: "Project",
          name: "미리내 프로젝트",
          existingItemId: pick("미리내 프로젝트") ?? null,
        },
        { ref: "Y", type: "System", name: Y_NAME, existingItemId: pick(Y_NAME) ?? null },
      ],
      facts: [
        {
          item: "Y",
          kind: "completion_date",
          value: match[2],
          epistemic: "explicit",
          quote: match[0],
        },
      ],
      relations: [{ subject: "X", type: "DEPENDS_ON", object: "Y", quote: DEPENDS }],
    };
  };
}

let dir: string;
let db: SqlDriver;
let runner: JobRunner | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-deletion-"));
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function consent(egress: EgressControls) {
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  const granted = egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

function pipeline(hooks: { during?: ((request: StructuredRequest) => void) | undefined } = {}) {
  const provider = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer: answer(hooks),
  });
  writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id); // the user's default (V01-T10)
  const egress = productEgress(db);
  const { broker } = productCalls(db, egress, { providers: [provider] });
  runner = productRunner(db, broker);
  consent(egress);
  // not woken by the import: each test runs the jobs itself, after what it arranges
  return { provider, runner, importer: productImporter(db) };
}

/** The time a Connector reports with its change; the tombstone never takes it. */
const CONNECTOR_AT = "1999-01-01T00:00:00Z";

/** A Connector of the JSONL kind reporting one change of `externalId`. */
function reporting(kind: "delete" | "access-revoked", externalId: string): Connector {
  const page: ChangeSet = {
    changes: [{ kind, namespace: "", externalId, revision: 9, at: CONNECTOR_AT }],
    nextCursor: "1",
    hasMore: false,
  };
  return {
    manifest: {
      type: JSONL_CONNECTOR_KIND,
      schemaVersion: 2,
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
      },
    },
    initialize: async () => {},
    healthCheck: async () => ({ state: "ok" }),
    getChanges: async () => page,
    getDocument: async () => null,
  };
}
const report = (instance: string, kind: "delete" | "access-revoked", externalId: string) =>
  syncConnector(db, instance, JSONL_CONNECTOR_KIND, reporting(kind, externalId), { rescan: true });

/** The database file and every side file next to it (-journal, -wal, -shm), as bytes. */
function storedFiles(): [string, Buffer][] {
  return readdirSync(dir)
    .filter((f) => f.startsWith(CANONICAL_DB_FILE))
    .map((f) => [f, readFileSync(join(dir, f))]);
}
const canariesIn = () =>
  Object.values(CANARY).filter((c) => storedFiles().some(([, bytes]) => bytes.includes(c)));

const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;
/** By identity, across the instances the flows use: a purged source's row holds the hash (I04-R7). */
const sourceId = (externalId: string) =>
  db
    .all("SELECT DISTINCT connector_instance_id AS id FROM sources")
    .map((r) => findSourceId(db, r.id as string, "", externalId))
    .find((id) => id !== undefined) as number;

/** Mail (X targets 12-05), then K's v1 (Y completes 12-10) and v2 (12-12), each extracted. */
async function canaryFlow() {
  const flow = pipeline();
  await flow.importer(read("v02-mail.jsonl"));
  await flow.runner.wake();
  await flow.importer(kVersion(1, CANARY.old, "2026-12-10"));
  await flow.runner.wake();
  await flow.importer(kVersion(2, CANARY.quote, "2026-12-12"));
  await flow.runner.wake();
  return flow;
}

describe("delete.purge", () => {
  it.each([
    ["delete", "source-deleted"],
    ["access-revoked", "access-revoked"],
  ] as const)(
    "leaves none of a %s source's text in the file or its side files, keeping shared knowledge (①②③④)",
    async (kind, reason) => {
      await canaryFlow();
      // every canary is stored before (title, both bodies, quotes, Y's name in the summary)
      expect(canariesIn()).toEqual(Object.values(CANARY));
      expect(
        db.all("SELECT value, status FROM facts WHERE kind = 'completion_date' ORDER BY id"),
      ).toEqual([
        { value: "2026-12-10", status: "superseded" },
        { value: "2026-12-12", status: "candidate" },
      ]);
      expect(db.all("SELECT state, summary FROM insights")).toEqual([
        { state: "active", summary: expect.stringContaining(Y_NAME) },
      ]);

      await report("conn-k", kind, "k");

      expect(canariesIn()).toEqual([]);
      expect(storedFiles().map(([f]) => f)).toEqual([CANONICAL_DB_FILE]);
      // ② the old version, its quote and its superseded fact went too
      expect(db.all("SELECT value FROM facts ORDER BY id")).toEqual([{ value: "2026-12-05" }]);
      expect(count("source_versions")).toBe(1);
      expect(db.all("SELECT name FROM items")).toEqual([{ name: "미리내 프로젝트" }]);
      expect(count("insights")).toBe(0);
      // ③ the tombstone holds the identifier, the version it covers, a time and the reason
      // (I04-R9 adds the source's revision and the lift time; still no content)
      expect(db.all("SELECT name FROM pragma_table_info('tombstones') ORDER BY cid")).toEqual(
        ["source_id", "covers_version", "last_revision", "at", "reason", "lifted_at"].map(
          (name) => ({ name }),
        ),
      );
      const tombstone = readTombstone(db, sourceId("k"));
      expect(tombstone).toMatchObject({ version: 2, reason });
      // the product's clock, never the Connector's text
      expect(Number.isNaN(Date.parse(tombstone?.at ?? ""))).toBe(false);
      expect(tombstone?.at).not.toBe(CONNECTOR_AT);
    },
  );
});

describe("delete.propagate", () => {
  it("resolves and empties the Insight when the dependency's source is deleted, keeping both items", async () => {
    const { runner, importer } = pipeline();
    const plain = ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl"].map(read);
    await importer(plain.join("\n"));
    await runner.wake();
    const [before] = db.all("SELECT id, state FROM insights");
    expect(before).toMatchObject({ state: "active" });

    const wiki = JSON.parse(plain[1] as string) as Record<string, unknown>;
    const result = await importer(jsonl({ ...wiki, operation: "delete", content: "", version: 2 }));

    expect(result).toEqual({ received: 1, created: 0, errors: [], errorCount: 0 });
    expect(db.all("SELECT id, state, summary FROM insights")).toEqual([
      { id: before?.id, state: "resolved", summary: null },
    ]);
    expect(count("insight_evidence")).toBe(0);
    expect(count("relations")).toBe(0);
    expect(db.all("SELECT kind FROM facts ORDER BY id")).toEqual([
      { kind: "target_date" },
      { kind: "completion_date" },
    ]);
    expect(count("items")).toBe(2);
    expect(readTombstone(db, sourceId(wiki.external_id as string))?.reason).toBe("source-deleted");
  });

  it("keeps a fact another source also supports, with the Insight", async () => {
    const { runner, importer } = pipeline();
    const plain = ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl"].map(read);
    const copy = jsonl({ external_id: "<v02-target-copy@mail.example.test>", id: "mail-copy" });
    await importer([...plain, copy].join("\n"));
    await runner.wake();
    const [target] = db.all("SELECT id FROM facts WHERE kind = 'target_date'");
    expect(
      db.all("SELECT count(*) AS n FROM evidence WHERE fact_id = ?", [target?.id ?? 0]),
    ).toEqual([{ n: 2 }]);

    await report("conn-v02-mail", "delete", MAIL.external_id as string);

    expect(db.all("SELECT id FROM facts WHERE kind = 'target_date'")).toEqual([target]);
    expect(
      db.all("SELECT count(*) AS n FROM evidence WHERE fact_id = ?", [target?.id ?? 0]),
    ).toEqual([{ n: 1 }]);
    expect(db.all("SELECT state FROM insights")).toEqual([{ state: "active" }]);
  });

  it("closes a job queued before the purge as superseded without calling the Provider", async () => {
    const { provider, runner, importer } = pipeline();
    await importer(read("v02-mail.jsonl"));
    await report("conn-v02-mail", "delete", MAIL.external_id as string);
    await runner.wake();
    expect(provider.requests).toHaveLength(0);
    expect(db.all("SELECT status FROM jobs")).toEqual([{ status: "superseded" }]);
  });

  it("discards the result of a job leased before the purge (its lease closed by the purge)", async () => {
    const hooks: { during?: () => void } = {};
    const { provider, runner, importer } = pipeline(hooks);
    await importer(read("v02-mail.jsonl"));
    hooks.during = () =>
      void deleteSource(db, sourceId(MAIL.external_id as string), {
        reason: "user-deleted",
        at: new Date().toISOString(),
      });
    await runner.wake();
    expect(provider.requests).toHaveLength(1);
    // the purge closed the running job (I04-R12, supersedeOpenJobs): its holder's
    // close no longer holds the lease, so nothing of its result is written
    expect(db.all("SELECT status, reason FROM jobs")).toEqual([
      { status: "superseded", reason: "source-closed" },
    ]);
    expect([count("items"), count("facts"), count("evidence")]).toEqual([0, 0, 0]);
  });

  it("does not bring back an item deleted between the Provider call and the write, and discards the result drawn on it (A-W3, I04-R11)", async () => {
    const hooks: { during?: ((request: StructuredRequest) => void) | undefined } = {};
    const { runner, importer } = pipeline(hooks);
    await importer(read("v02-mail.jsonl"));
    await runner.wake();
    const [x] = db.all("SELECT id FROM items");
    // K names X, a candidate whose only source (the mail) goes while K is extracted
    hooks.during = (request) => {
      hooks.during = undefined; // once: the re-extraction must not delete again
      expect(request.input.candidates.map((c) => c.id)).toContain(String(x?.id));
      deleteSource(db, sourceId(MAIL.external_id as string), {
        reason: "user-deleted",
        at: new Date().toISOString(),
      });
    };
    await importer(kVersion(1, CANARY.old, "2026-12-10"));
    await runner.wake();

    // X is not brought back through its stale id (SQLite reuses the highest rowid, so
    // that id would have resolved to Y): K's first result drew on the mail through X,
    // whose source is gone, so commitDerived discarded all of it (assertLineage,
    // I04-R11) and closed the job superseded (lineage-covered). The one re-extraction
    // it queued ran with X no longer a candidate: K's own result, relation included.
    const jobs = db.all("SELECT status, reason FROM jobs ORDER BY id DESC LIMIT 2");
    expect(jobs).toEqual([
      { status: "succeeded", reason: null },
      { status: "superseded", reason: "lineage-covered" },
    ]);
    expect(db.all("SELECT name FROM items ORDER BY name").map((r) => r.name)).toEqual(
      ["미리내 프로젝트", Y_NAME].sort(),
    );
    expect(count("facts")).toBe(1);
    expect(count("relations")).toBe(1);
    // the relation joins the two items of this extraction: nothing points at a freed id
    expect(
      db.all(
        `SELECT s.name AS subject, o.name AS object FROM relations r
           JOIN items s ON s.id = r.subject_id JOIN items o ON o.id = r.object_id`,
      ),
    ).toEqual([{ subject: "미리내 프로젝트", object: Y_NAME }]);
  });

  it("keeps no orphan item from a relation whose other end was deleted during the call (B1, I04-R11)", async () => {
    const hooks: { during?: ((request: StructuredRequest) => void) | undefined } = {};
    const { runner, importer } = pipeline(hooks);
    await importer(read("v02-mail.jsonl"));
    await runner.wake();
    hooks.during = () =>
      void deleteSource(db, sourceId(MAIL.external_id as string), {
        reason: "user-deleted",
        at: new Date().toISOString(),
      });
    await importer(jsonl({ ...K, title: "k", content: `합성. ${ORPHAN_DEPENDS}.` }));
    await runner.wake();

    // X went with the mail, so the first result (a relation on X) was discarded whole
    // (superseded, lineage-covered); the re-extraction, X no longer a candidate, made
    // Z and a new X for the relation
    expect(db.all("SELECT status, reason FROM jobs ORDER BY id DESC LIMIT 2")).toEqual([
      { status: "succeeded", reason: null },
      { status: "superseded", reason: "lineage-covered" },
    ]);
    expect(db.all("SELECT name FROM items ORDER BY name").map((r) => r.name)).toEqual(
      ["미리내 프로젝트", ORPHAN_NAME].sort(),
    );
    deleteSource(db, sourceId("k"), { reason: "user-deleted", at: new Date().toISOString() });
    db.close();
    const left = storedFiles().filter(([, bytes]) => bytes.includes("orphcanary"));
    db = openCanonicalDb(dir);
    expect(left.map(([f]) => f)).toEqual([]);
  });

  it("refuses the source again at or below its tombstone, whatever revision comes (re-arrival)", async () => {
    const { importer } = pipeline();
    await importer(read("v02-mail.jsonl"));
    await report("conn-v02-mail", "delete", MAIL.external_id as string);
    const jobs = count("jobs");

    const again = await importer(
      [read("v02-mail.jsonl"), jsonl({ version: 7, content: "더 새 revision의 합성 본문" })].join(
        "\n",
      ),
    );

    expect(again).toEqual({
      received: 2,
      created: 0,
      errors: [
        { line: 1, reason: "tombstoned" },
        { line: 2, reason: "tombstoned" },
      ],
      errorCount: 2,
    });
    expect([count("source_versions"), count("jobs")]).toEqual([0, jobs]);
  });
});
