// I02B-R21 / I02B-C35: a sync that would run past I03's run-time cap yields at a page boundary. A fake
// monotonic clock moves by one "slow page" each time the stand-in Connector is read; the real runner, the
// real `connector-sync` handler and the real manager do the rest. Nothing waits on the wall clock.
import { SYNC_OUTCOMES } from "@pki/connector-sdk";
import { readCursor, readJob, registerJob, type SqlDriver } from "@pki/storage";
import { ScriptedConnector, dirTemplate } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { openCanonicalDb } from "./composition.ts";
import { createConnectorManager } from "./connectors.ts";
import { CONNECTOR_SYNC_KIND, CONNECTOR_SYNC_SETTINGS, createConnectorSyncHandler } from "./connector-sync-job.ts";
import { DEFAULT_RUN_TIMEOUT_MS, YIELD_DELAY_MS } from "./job-outcomes.ts";
import { createJobRunner } from "./job-runner.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

let dir: string;
let db: SqlDriver;
let wall: number;
let mono: number;
const T0 = Date.parse("2026-11-23T00:00:00.000Z");
const clock: Clock = {
  now: () => wall,
  monotonic: () => mono,
  sleep: async () => {},
};

const PAGES = 7;
/** Each page read costs this much run time on the fake clock: three of them are more than the cap's 80%. */
const PAGE_COST_MS = 3 * 60_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-yield-"));
  seedDataDir(join(dir, "data"));
  db = openCanonicalDb(join(dir, "data"));
  wall = T0;
  mono = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const entries = Array.from({ length: PAGES }, (_, i) => ({
  kind: "upsert",
  record: {
    namespace: "",
    externalId: `s${i}`,
    revision: 1,
    schemaVersion: 2,
    title: `t${i}`,
    body: `b${i}`,
  },
}));

async function setup() {
  const manager = await createConnectorManager(
    db,
    [
      {
        id: "c1",
        kind: "slow",
        config: {
          entries,
          pageSize: 1,
          beforeAnswer: () => {
            mono += PAGE_COST_MS; // a slow page
          },
        },
      },
    ],
    { slow: () => new ScriptedConnector() },
    { clock },
  );
  const runner = createJobRunner({
    db,
    clock,
    kinds: { [CONNECTOR_SYNC_KIND]: CONNECTOR_SYNC_SETTINGS },
    handlers: { [CONNECTOR_SYNC_KIND]: createConnectorSyncHandler({ db, manager: () => manager }) },
  });
  return { manager, runner };
}

describe("connector-sync.yield (I02B-C35): a long sync yields at a page boundary, and the next runs go on", () => {
  it("is cut before the run-time cap, spends no attempt, keeps its pages, and every page lands with no dead letter", async () => {
    const { runner } = await setup();
    const queued = registerJob(db, { kind: CONNECTOR_SYNC_KIND, target: "c1", at: new Date(wall) });
    if (!queued.registered) throw new Error("expected a new job");
    const id = queued.job.id;

    let yields = 0;
    for (let run = 0; run < PAGES + 2 && readJob(db, id)?.status !== "succeeded"; run++) {
      mono = 0; // each run is timed from its own start
      await runner.runOnce();
      const after = readJob(db, id);
      if (after?.status === "succeeded") break;
      yields++;
      // yielded: queued again a minute later, the attempt given back, never near the cap
      expect(after).toMatchObject({ status: "queued", attempts: 0, runAfter: wall + YIELD_DELAY_MS });
      expect(mono).toBeLessThan(DEFAULT_RUN_TIMEOUT_MS);
      expect(readCursor(db, "c1")).not.toBeNull(); // the stored cursor stays
      wall += YIELD_DELAY_MS;
    }
    expect(yields).toBeGreaterThan(0);
    expect(readJob(db, id)?.status).toBe("succeeded");
    expect(db.all("SELECT COUNT(*) AS n FROM sources WHERE connector_instance_id = 'c1'")[0]?.n).toBe(PAGES);
    expect(db.all("SELECT COUNT(*) AS n FROM jobs WHERE status = 'dead_letter'")[0]?.n).toBe(0);
  });

  it("is the table's row: a yield result, no attempt spent, a minute later", () => {
    expect(SYNC_OUTCOMES.find((r) => r.end === "yield")).toMatchObject({
      result: "yield",
      attempt: "unspent",
      nextRun: "one-minute",
    });
  });
});
