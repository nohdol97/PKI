// S03-T05 `check.job` (the backend part, S03-R6 last line, R11, R12): the product runner runs the
// `analytical-check` job after a profile, with no Provider call; the membership receiver is in the composition
// root's fixed list, so a merge, an unmerge and a split through the user's entry queue the reached source's job and
// change no row's state; with the profile switched OFF a new version of a bound table queues the check job.
import { CONNECTOR_SDK_VERSION, routes } from "@pki/contracts";
import { JSONL_CAPABILITIES } from "@pki/connector-sdk";
import {
  ANALYTICAL_CHECK_JOB_KIND,
  DATASET_PROFILE_KIND,
  insertItem,
  listCheckLines,
  registerAnalyticalCheckJob,
  registerConnectorInstance,
  saveDatasetTable,
  saveFact,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { FakeProvider, send, dirTemplate } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { openCanonicalDb, productUserDecisions } from "./composition.ts";
import { storePage } from "./page-store.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const TOKEN = "t".repeat(43);
const AT = "2026-11-23T01:02:03.000Z";
let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-check-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const CSV_BODY = "id\tamount\n1\t10";
const csvBlocks = [
  { start: 0, end: 2, locator: { format: "csv", record: 1, line: 1, field: 1 } },
  { start: 3, end: 9, locator: { format: "csv", record: 1, line: 1, field: 2 } },
  { start: 10, end: 11, locator: { format: "csv", record: 2, line: 2, field: 1 } },
  { start: 12, end: 14, locator: { format: "csv", record: 2, line: 2, field: 2 } },
];
const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "t",
} as const;
const checkJobs = (db: SqlDriver) =>
  db
    .all("SELECT source_id, fence_version, target, status FROM jobs WHERE kind = ? ORDER BY id", [
      ANALYTICAL_CHECK_JOB_KIND,
    ])
    .map((r) => ({ ...r }));

describe("check.job: through the product runner", () => {
  it("check.job: through the product runner a table import is profiled, then checked, with no Provider call", async () => {
    const provider = new FakeProvider({ id: "local-model", transport: "http", answer: () => ({}) });
    booted = await bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [provider],
    });
    const { db, server } = booted;
    registerConnectorInstance(db, "inst", "test-fixtures");
    const saved = saveSourceRecord(db, "inst", {
      namespace: "",
      externalId: "a",
      title: "표 a",
      body: CSV_BODY,
      blocks: csvBlocks,
    } as Parameters<typeof saveSourceRecord>[2]);
    if (saved.status !== "created") throw new Error("not stored");
    const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
    await send(server.port, routes.setAnalyticalSettings.path, headers, "POST", {
      profile: true,
      maxCells: 200_000,
    });
    await vi.waitFor(() =>
      expect(db.all("SELECT status FROM jobs WHERE kind = ?", [ANALYTICAL_CHECK_JOB_KIND])).toEqual(
        [{ status: "succeeded" }],
      ),
    );
    expect(db.all("SELECT status FROM jobs WHERE kind = ?", [DATASET_PROFILE_KIND])).toEqual([
      { status: "succeeded" },
    ]);
    // a Grain fact added now is checked by the next job, and the line is the job's
    const dataset = db.all("SELECT id FROM items WHERE type = 'Dataset'")[0]?.id as number;
    const grain = saveFact(db, {
      itemId: dataset,
      kind: "dataset.grain",
      value: '["id"]',
      ...attrs,
    }).id;
    expect(registerAnalyticalCheckJob(db, saved.sourceId)).toBe(true);
    void booted.runner.wake();
    await vi.waitFor(() =>
      expect(listCheckLines(db, grain).map((l) => l.check)).toEqual(["grain", "schema"]),
    );
    expect(listCheckLines(db, grain).every((l) => l.passed && l.current)).toBe(true);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("check.job: the receiver in the fixed list and the new-version fallback", () => {
  let db: SqlDriver;
  beforeEach(() => {
    seedDataDir(dir);
    db = openCanonicalDb(dir);
    registerConnectorInstance(db, "inst", "test-fixtures");
  });
  afterEach(() => db.close());

  const table = (id: string) => {
    const saved = saveSourceRecord(db, "inst", {
      namespace: "",
      externalId: id,
      title: id,
      body: CSV_BODY,
      blocks: csvBlocks,
    } as Parameters<typeof saveSourceRecord>[2]);
    if (saved.status !== "created") throw new Error("not stored");
    const item = insertItem(db, { type: "Dataset", name: id, ...attrs });
    saveDatasetTable(db, { itemId: item, sourceId: saved.sourceId, key: "", rowCount: 1 });
    return { item, sourceId: saved.sourceId };
  };
  const state = () =>
    ["items", "facts", "relations", "item_history", "fact_history", "relation_history"].map((t) =>
      db.all(`SELECT * FROM ${t} ORDER BY 1, 2`),
    );

  it("check.job: after a merge, an unmerge and a split through the user's entry the reached source's job is queued and no row's state, epistemic type or history changed", () => {
    const [x, y] = [table("x"), table("y")] as const;
    const grain = saveFact(db, {
      itemId: x.item,
      kind: "dataset.grain",
      value: '["id"]',
      ...attrs,
    }).id;
    const decisions = productUserDecisions({ combinable: () => true });
    const merged = db.transaction(() => decisions.entities.merge(db, y.item, x.item, AT));
    if (merged.status !== "applied") throw new Error(merged.reason);
    expect(checkJobs(db).map((j) => j.source_id)).toEqual([x.sourceId, y.sourceId]);
    db.run("DELETE FROM jobs");
    const before = state();
    db.transaction(() => decisions.entities.unmerge(db, merged.mergeId, false, AT));
    db.transaction(() =>
      decisions.entities.split(db, x.item, [{ kind: "fact", id: grain }], "split", AT),
    );
    expect(checkJobs(db).length).toBeGreaterThan(0);
    // only the lines the user entry itself wrote (item history) and the moved row's item differ from `before`
    const after = state();
    expect(after[1]).toEqual(before[1]?.map((f) => ({ ...f, item_id: expect.any(Number) })));
    expect(after[1]?.map((f) => [f.status, f.epistemic])).toEqual(
      before[1]?.map((f) => [f.status, f.epistemic]),
    );
    expect(after[4]).toEqual(before[4]); // no fact history line
    expect(after[5]).toEqual(before[5]); // no relation history line
  });

  it("check.job: with the profile switched OFF afterwards, a new version of the bound table queues the check job", () => {
    const send_ = (revision: number, body: string) =>
      storePage(
        {
          db,
          instanceId: "inst",
          kind: "test-fixtures",
          capabilities: JSONL_CAPABILITIES,
          options: {},
        },
        {
          changes: [
            {
              kind: "upsert" as const,
              record: {
                namespace: "",
                externalId: "a",
                revision,
                schemaVersion: CONNECTOR_SDK_VERSION,
                title: "a",
                body,
                blocks: csvBlocks,
                accessScope: ["user:me"],
              },
            },
          ],
          rejected: [],
          nextCursor: null,
          endsRescan: false,
        },
      );
    send_(1, CSV_BODY);
    const bound = db.all("SELECT id FROM sources")[0]?.id as number;
    const item = insertItem(db, { type: "Dataset", name: "a", ...attrs });
    saveDatasetTable(db, { itemId: item, sourceId: bound, key: "", rowCount: 1 });
    expect(checkJobs(db)).toEqual([]);
    send_(2, "id\tamount\n1\t11");
    expect(checkJobs(db)).toEqual([
      { source_id: bound, fence_version: 2, target: "run:1", status: "queued" },
    ]);
    expect(db.all("SELECT 1 FROM jobs WHERE kind = ?", [DATASET_PROFILE_KIND])).toEqual([]);
  });
});
