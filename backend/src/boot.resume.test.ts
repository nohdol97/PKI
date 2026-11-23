// H02A-C7 (backend half): after the OS wakes, `resumed()` brings the schedule check forward
// (spec 2026-11-24-H02-common, R11, D9). A schedule overdue is made by moving its next due
// time into the past; the 30-second check has not run in between.
import { updateSchedule } from "@pki/storage";
import { FakeProvider, fixtureExtraction } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-resume-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("BootedBackend.resumed", () => {
  it("H02A-C7: registers the job of an overdue period without waiting for the next check", async () => {
    booted = await bootBackend({
      dataDir: dir,
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [
        new FakeProvider({ id: "local-model", transport: "http", answer: fixtureExtraction() }),
      ],
    });
    const { schedule } = booted.scheduler.ensureSchedule({
      kind: "resume-probe",
      target: "t",
      period: { kind: "hourly" },
    });
    const jobs = () => booted!.db.all("SELECT id FROM jobs WHERE kind = 'resume-probe'");
    expect(jobs()).toHaveLength(0);
    updateSchedule(booted.db, schedule.id, { nextDue: Date.now() - 3 * 3_600_000 }, Date.now());
    booted.resumed();
    expect(jobs()).toHaveLength(1);
  });
});
