// The backend the kill tests start and kill (I03-R24, job-kill.test.ts), run by
// vitest.job-kill.config.ts as a test build: the real bootBackend on the test's data
// directory with a short job lease and poll, and the `test-effect` kind, both
// honoured in a test build only. It runs until killed. Not a test of its own: its
// name is outside the suite's pattern.
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { bootBackend } from "./boot.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { createTestEffectHandler, TEST_EFFECT_JOB_KIND } from "./test-effect.ts";

const setting = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
};

it("runs the backend until killed", async () => {
  const runLog = setting("PKI_KILL_RUN_LOG");
  const pause = setting("PKI_KILL_PAUSE").split(",").filter(Boolean);
  await bootBackend({
    dataDir: setting("PKI_KILL_DATA_DIR"),
    token: "k".repeat(43),
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    testBuild: {
      jobs: {
        leaseMs: Number(setting("PKI_KILL_LEASE_MS")),
        pollMs: 100,
        handlers: (db) => ({
          [TEST_EFFECT_JOB_KIND]: createTestEffectHandler(db, { runLog, pause }),
        }),
      },
    },
  });
  writeFileSync(setting("PKI_KILL_READY"), String(process.pid));
  await new Promise<never>(() => {});
});
