// S03-T04 `profile.dataset` (the backend part, S03-R6, C1, root 13-5 dark launch): the profile is OFF by
// default and then no `dataset-profile` job exists, whatever is imported; ON, a new version of a table source
// gets one (the page store registers it in the version's own transaction); turning it ON registers one for the
// current version of every table source already stored, and turning it ON again registers none. The runner
// runs the job and makes the Dataset without a Provider call.
import { CONNECTOR_SDK_VERSION, routes } from "@pki/contracts";
import { JSONL_CAPABILITIES } from "@pki/connector-sdk";
import {
  DATASET_PROFILE_KIND,
  readSetting,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { FakeProvider, send, dirTemplate } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { openCanonicalDb } from "./composition.ts";
import { storePage } from "./page-store.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const TOKEN = "t".repeat(43);
let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-profile-"));
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
const jobKinds = (db: SqlDriver) =>
  db
    .all("SELECT kind, source_id, fence_version FROM jobs ORDER BY id")
    .map((r) => [r.kind as string, r.source_id as number, r.fence_version as number]);
const profileJobs = (db: SqlDriver) => jobKinds(db).filter(([k]) => k === DATASET_PROFILE_KIND);

/** A table source's change as a Connector would send it: a record with CSV blocks. */
const csvChange = (externalId: string, revision: number, body = CSV_BODY) => ({
  kind: "upsert" as const,
  record: {
    namespace: "",
    externalId,
    revision,
    schemaVersion: CONNECTOR_SDK_VERSION,
    title: `표 ${externalId}`,
    body,
    blocks: csvBlocks,
    accessScope: ["user:me"],
  },
});
const proseChange = (externalId: string, revision: number) => ({
  kind: "upsert" as const,
  record: {
    namespace: "",
    externalId,
    revision,
    schemaVersion: CONNECTOR_SDK_VERSION,
    title: "글",
    body: "문장",
    blocks: [{ start: 0, end: 2, locator: { format: "txt", line: 1 } }],
    accessScope: ["user:me"],
  },
});

function store(db: SqlDriver, ...changes: object[]) {
  const result = storePage(
    {
      db,
      instanceId: "inst",
      kind: "test-fixtures",
      capabilities: JSONL_CAPABILITIES,
      options: {},
    },
    { changes, rejected: [], nextCursor: null, endsRescan: false },
  );
  if ("stopped" in result) throw new Error(result.stopped);
  expect(result.rejected).toEqual([]);
  return result;
}

describe("profile.dataset: the page store registers the job of a new version", () => {
  let db: SqlDriver;
  beforeEach(() => {
    seedDataDir(dir);
    db = openCanonicalDb(dir);
    registerConnectorInstance(db, "inst", "test-fixtures");
  });
  afterEach(() => db.close());

  it("registers none while the setting is OFF (the default): the table source gets its extraction job only", () => {
    expect(readSetting(db, "analytical.profile")).toBeUndefined();
    store(db, csvChange("a", 1), proseChange("b", 1));
    expect(jobKinds(db).map(([k]) => k)).toEqual(["extract", "extract"]);
    expect(db.all("SELECT 1 FROM items")).toEqual([]);
    expect(db.all("SELECT 1 FROM dataset_tables")).toEqual([]);
  });

  it("registers one, fenced to the new version, for a table source while ON, and none for prose", () => {
    db.run("INSERT INTO settings (key, value) VALUES ('analytical.profile', 'on')");
    store(db, csvChange("a", 1), proseChange("b", 1));
    expect(jobKinds(db)).toEqual([
      ["extract", 1, 1],
      [DATASET_PROFILE_KIND, 1, 1],
      ["extract", 2, 1],
    ]);
    // a new version of the same source: one more, on version 2
    store(db, csvChange("a", 2, "id\tamount\n1\t11"));
    expect(profileJobs(db)).toEqual([
      [DATASET_PROFILE_KIND, 1, 1],
      [DATASET_PROFILE_KIND, 1, 2],
    ]);
  });
});

describe("profile.dataset: the setting, its switch, and the runner", () => {
  const boot = async () => {
    const provider = new FakeProvider({ id: "local-model", transport: "http", answer: () => ({}) });
    booted = await bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [provider],
    });
    const { port } = booted.server;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    return {
      db: booted.db,
      provider,
      get: (path: string) => send(port, path, headers),
      post: (path: string, body: unknown) => send(port, path, headers, "POST", body),
    };
  };
  const seed = (db: SqlDriver, id: string) => {
    registerConnectorInstance(db, "inst", "test-fixtures");
    const saved = saveSourceRecord(db, "inst", {
      namespace: "",
      externalId: id,
      title: `표 ${id}`,
      body: CSV_BODY,
      blocks: csvBlocks,
    } as Parameters<typeof saveSourceRecord>[2]);
    if (saved.status !== "created") throw new Error("not stored");
    return saved.sourceId;
  };

  it("reads OFF and the default limit before anything is set", async () => {
    const { get } = await boot();
    expect((await get(routes.analyticalSettings.path)).body).toEqual({
      profile: false,
      maxCells: 200_000,
    });
  });

  it("turning it ON queues one job per table source imported while OFF, and turning it ON again none", async () => {
    const { db, get, post } = await boot();
    const a = seed(db, "a");
    const b = seed(db, "b");
    const prose = saveSourceRecord(db, "inst", {
      namespace: "",
      externalId: "prose",
      title: "글",
      body: "문장",
      blocks: [{ start: 0, end: 2, locator: { format: "txt", line: 1 } }],
    } as Parameters<typeof saveSourceRecord>[2]);
    expect(prose.status).toBe("created");
    expect(profileJobs(db)).toEqual([]);

    const on = await post(routes.setAnalyticalSettings.path, { profile: true, maxCells: 200_000 });
    expect(on.body).toEqual({ profile: true, maxCells: 200_000 });
    await vi.waitFor(() =>
      expect(db.all("SELECT status FROM jobs WHERE kind = ?", [DATASET_PROFILE_KIND])).toEqual([
        { status: "succeeded" },
        { status: "succeeded" },
      ]),
    );
    expect(profileJobs(db)).toEqual([
      [DATASET_PROFILE_KIND, a, 1],
      [DATASET_PROFILE_KIND, b, 1],
    ]);
    expect(db.all("SELECT type, name FROM items ORDER BY id")).toEqual([
      { type: "Dataset", name: "표 a" },
      { type: "Dataset", name: "표 b" },
    ]);
    expect(db.all("SELECT table_key, row_count FROM dataset_tables ORDER BY id")).toEqual([
      { table_key: "", row_count: 1 },
      { table_key: "", row_count: 1 },
    ]);
    expect((await get(routes.analyticalSettings.path)).body).toEqual({
      profile: true,
      maxCells: 200_000,
    });

    // ON again: nothing new (the jobs are not queued twice, nothing is made twice)
    await post(routes.setAnalyticalSettings.path, { profile: true, maxCells: 200_000 });
    expect(profileJobs(db)).toHaveLength(2);
    // OFF stores the setting and queues nothing
    expect(
      (await post(routes.setAnalyticalSettings.path, { profile: false, maxCells: 5000 })).body,
    ).toEqual({
      profile: false,
      maxCells: 5000,
    });
    expect(profileJobs(db)).toHaveLength(2);
  });

  it("runs the profile without a Provider call", async () => {
    const { db, post, provider } = await boot();
    seed(db, "a");
    await post(routes.setAnalyticalSettings.path, { profile: true, maxCells: 200_000 });
    await vi.waitFor(() =>
      expect(db.all("SELECT status FROM jobs WHERE kind = ?", [DATASET_PROFILE_KIND])).toEqual([
        { status: "succeeded" },
      ]),
    );
    expect(provider.requests).toHaveLength(0);
  });

  it("refuses a limit that is not a whole number of cells from 1 to 10,000,000, and stores nothing", async () => {
    const { get, post } = await boot();
    for (const maxCells of [0, -1, 1.5, 10_000_001, "5"]) {
      const response = await post(routes.setAnalyticalSettings.path, { profile: true, maxCells });
      expect(response.status, String(maxCells)).toBe(400);
    }
    expect((await post(routes.setAnalyticalSettings.path, { profile: true })).status).toBe(400);
    expect((await get(routes.analyticalSettings.path)).body).toEqual({
      profile: false,
      maxCells: 200_000,
    });
  });
});
