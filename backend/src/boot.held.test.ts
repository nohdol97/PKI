// I03-T07 rework: the boot wiring of held jobs (I03-R16 ②③) on the real bootBackend:
// the start pass of the clock's re-evaluation, and the policy fingerprint stamped by
// the runner and compared at the next start (a restart alone lifts nothing; a changed
// input lifts only what the fingerprint can end).
import { computePolicyVersion, DEFAULT_PROVIDER_SETTING } from "@pki/providers";
import {
  readJob,
  registerConnectorInstance,
  registerJob,
  saveConsent,
  saveSourceRecord,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { FakeProvider, fixtureExtraction } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { openCanonicalDb } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-held-"));
});
afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

async function stop() {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
}

const provider = () =>
  new FakeProvider({ id: "local-model", transport: "http", answer: fixtureExtraction() });
const boot = (p: FakeProvider = provider()) =>
  bootBackend({
    dataDir: dir,
    token: "t".repeat(43),
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [p],
  });

/** Queued extraction jobs in the data directory before any backend runs on it. */
function seed(count: number, edit?: (db: SqlDriver) => void): void {
  const db = openCanonicalDb(dir);
  try {
    writeSetting(db, DEFAULT_PROVIDER_SETTING, "local-model");
    registerConnectorInstance(db, "seeded", "jsonl-import");
    for (let i = 0; i < count; i++) {
      const saved = saveSourceRecord(db, "seeded", {
        externalId: `s${i}`,
        title: "t",
        body: `seeded ${i}`,
      });
      if (saved.status !== "created") throw new Error("expected a version");
      registerJob(db, { kind: "extract", sourceId: saved.sourceId, fenceVersion: saved.version });
    }
    edit?.(db);
  } finally {
    db.close();
  }
}

function withDb(fn: (db: SqlDriver) => void) {
  const db = openCanonicalDb(dir);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe("held.release at boot (I03-R16 ②)", () => {
  it("runs the clock's re-evaluation at start: a job held for a reason only the clock ends is judged without waiting an hour", async () => {
    const p = provider();
    seed(1, (db) => {
      saveConsent(db, {
        provider: "local-model",
        destination: "local-model",
        policyVersion: computePolicyVersion([]),
        allowedClasses: ["general"],
        grantedAt: "2026-11-22T00:00:00.000Z",
      });
      // stamped with another fingerprint: only the clock's pass can lift this reason
      db.run(
        `UPDATE jobs SET status = 'held', reason = 'capabilities-unavailable',
           policy_fingerprint = 'pf-seeded'`,
      );
    });
    booted = await boot(p);
    await vi.waitFor(() => expect(p.requests).toHaveLength(1));
    expect(readJob(booted.db, 1)?.status).not.toBe("held");
  });
});

describe("policy fingerprint across restarts (I03-R16 ③)", () => {
  it("keeps no-consent and rule-denied held on a restart of the same build, and a changed input lifts only the rule one", async () => {
    seed(2);
    booted = await boot();
    await vi.waitFor(() =>
      expect(booted?.db.all("SELECT status FROM jobs WHERE status = 'held'")).toHaveLength(2),
    );
    const stamped = readJob(booted.db, 1)?.policyFingerprint;
    expect(stamped).toMatch(/^pf-/); // the runner of the boot wiring stamps its holds
    booted.db.run("UPDATE jobs SET reason = 'rule-denied' WHERE id = 2");
    const tokens = [1, 2].map((id) => readJob(booted?.db as SqlDriver, id)?.leaseToken);
    await stop();

    booted = await boot(); // the same build: nothing a restart alone may lift
    await booted.runner.wake();
    expect([1, 2].map((id) => readJob(booted?.db as SqlDriver, id))).toMatchObject([
      { status: "held", reason: "no-consent", leaseToken: tokens[0] },
      { status: "held", reason: "rule-denied", leaseToken: tokens[1] },
    ]);
    await stop();

    withDb((db) => writeSetting(db, DEFAULT_PROVIDER_SETTING, "codex")); // an input of the fingerprint
    booted = await boot();
    await vi.waitFor(() =>
      expect(readJob(booted?.db as SqlDriver, 2)).toMatchObject({
        status: "held",
        reason: "no-provider", // lifted, claimed, judged again under the new default
      }),
    );
    expect(readJob(booted.db, 1)).toMatchObject({
      status: "held",
      reason: "no-consent",
      leaseToken: tokens[0],
    });
  });
});
