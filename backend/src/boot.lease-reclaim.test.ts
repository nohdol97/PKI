// P7F-C2 (spec 2026-11-24-P7-followups, R1, R2): a start that holds the backend lock reclaims
// the `running` rows whatever their lease end says; a start that does not hold it takes nothing
// from the live backend that does. Two backends of one process conflict on the lock file just
// as two processes do; the cross-process kill is job-kill.test.ts.
import { readJob, registerJob, type SqlDriver } from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { openCanonicalDb } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { TEST_EFFECT_JOB_KIND } from "./test-effect.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-lease-reclaim-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const start = () =>
  bootBackend({
    dataDir: dir,
    token: "t".repeat(43),
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    testBuild: { jobs: { leaseMs: 600_000, pollMs: 50 } }, // no handler: a test-effect job stays where it is put
  });

/** A job another backend holds: running, its lease running out far ahead. */
function hold(db: SqlDriver): number {
  const r = registerJob(db, { kind: TEST_EFFECT_JOB_KIND, target: "x", at: new Date() });
  if (!r.registered) throw new Error("expected a new job");
  db.run("UPDATE jobs SET status = 'running', attempts = 1, lease_until = ? WHERE id = ?", [
    Date.now() + 3_600_000,
    r.job.id,
  ]);
  return r.job.id;
}

const read = (db: SqlDriver, id: number) => {
  const job = readJob(db, id);
  return { status: job?.status, token: job?.leaseToken, attempts: job?.attempts };
};

it("leaves a live backend's running job alone; reclaims a dead one's whatever its lease end", async () => {
  const a = await start();
  const id = hold(a.db);
  const before = read(a.db, id);

  // a second backend on the folder while the first lives: its lock is not obtained, nothing is taken
  const b = await start();
  expect(read(b.db, id)).toEqual(before);
  await b.server.close();
  b.db.close();

  // the first closes; the row it left `running` with a far lease end is the dead backend's
  await a.server.close();
  a.db.close();
  const db = openCanonicalDb(dir);
  const stale = read(db, id);
  db.close();

  const c = await start();
  const after = read(c.db, id);
  expect(after.status).toBe("queued");
  expect(after.token).toBe((stale.token as number) + 1);
  expect(after.attempts).toBe(stale.attempts);
  await c.server.close();
  c.db.close();
}, 60_000);
