// I03-T01 `jobs.migration-v02-status`, the start half: V02-T03's held jobs carry
// no policy fingerprint after the migration, which counts as changed (I03-R2), so
// the first start judges them once; a job held for size stays held (I03-R16).
import { migrate, migrations, readJob, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HELD_POLICY_SETTING, releaseOnPolicyChange } from "./composition.ts";
import { EXTRACT_HOLD_TOO_LARGE } from "@pki/knowledge-engine";

let db: SqlDriver;
const egress = { policyVersion: () => "pv-1" };
let wakes = 0;
const runner = { wake: async () => void wakes++ };

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db, migrations.slice(0, 10)); // the schema before the jobs migration (v11)
  db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
  db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'a')");
  for (const [version, reason] of [
    [1, "no-consent"],
    [2, EXTRACT_HOLD_TOO_LARGE],
  ] as const) {
    db.run(
      `INSERT INTO jobs (kind, source_id, fence_version, status, reason, lease_token)
       VALUES ('extract', 1, ?, 'held', ?, 1)`,
      [version, reason],
    );
  }
  // judged under the current rules already: V02 alone would not release them again
  db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [HELD_POLICY_SETTING, "pv-1"]);
  wakes = 0;
});

afterEach(() => db.close());

it("judges migrated held jobs once at the first start, keeping the one held for size", () => {
  expect(releaseOnPolicyChange(db, egress, runner)).toBe(0); // before the migration: not again
  migrate(db);
  expect(releaseOnPolicyChange(db, egress, runner)).toBe(1);
  expect(readJob(db, 1)).toMatchObject({ status: "queued", reason: null });
  expect(readJob(db, 2)).toMatchObject({ status: "held", reason: EXTRACT_HOLD_TOO_LARGE });
  expect(wakes).toBe(1);
  expect(releaseOnPolicyChange(db, egress, runner)).toBe(0); // once: the next start keeps them
});
