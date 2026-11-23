// P02-C3c ① ③ (outside the app, R3): the three `notify` jobs succeed with a Broker that throws when called (no
// Provider call), and the notification modules import no network, Connector or Broker module.
import { registerConnectorInstance, registerJob, type SqlDriver } from "@pki/storage";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productRunner } from "./composition.ts";
import { seedInsight } from "./notify.test-support.ts";

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-notify-egress-"));
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("notify.no-egress: no Provider call (P02-C3c ①)", () => {
  it("runs scan, daily and weekly to success with a Broker that throws when called", async () => {
    let calls = 0;
    const broker = {
      call: () => {
        calls++;
        throw new Error("a Provider call");
      },
      budgetUsage: () => {
        calls++;
        throw new Error("a Broker read");
      },
    } as unknown as Parameters<typeof productRunner>[1];
    seedInsight(db, { name: "하나" });
    const runner = productRunner(db, broker);
    for (const target of ["scan", "daily", "weekly"]) registerJob(db, { kind: "notify", target });

    await runner.wake();
    await runner.stop();

    expect(db.all("SELECT target, status FROM jobs WHERE kind = 'notify' ORDER BY target")).toEqual(
      [
        { target: "daily", status: "succeeded" },
        { target: "scan", status: "succeeded" },
        { target: "weekly", status: "succeeded" },
      ],
    );
    expect(calls).toBe(0);
  });
});

/** The notification modules of the product: `notify-*.ts` of the three packages, not their tests. */
const ROOT = resolve(import.meta.dirname, "../..");
const modules = ["backend/src", "knowledge-engine/src", "storage/src"].flatMap((pkg) =>
  readdirSync(join(ROOT, pkg))
    .filter((f) => /^notify-[\w-]+\.ts$/.test(f) && !/\.(test|e2e)\.ts$|test-support/.test(f))
    .map((f) => join(ROOT, pkg, f)),
);
const FORBIDDEN =
  /^(node:(https?|http2|net|tls|dgram|dns|child_process|worker_threads)|undici|node-fetch|axios|ws)$|^@pki\/(providers|connector-sdk)|(^|\/)(connectors?|connector-[\w-]+|job-broker|broker|egress)(\.ts)?$/;

describe("notify.no-egress: the notification modules import nothing that leaves the machine (P02-C3c ③)", () => {
  it("has modules to check, and none imports a network, Connector or Broker module or calls fetch", () => {
    expect(modules.length).toBeGreaterThanOrEqual(5);
    for (const file of modules) {
      const text = readFileSync(file, "utf8");
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (m) => m[1] as string,
      );
      expect(
        specifiers.filter((s) => FORBIDDEN.test(s)),
        file,
      ).toEqual([]);
      expect(/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(text), file).toBe(false);
    }
  });
});
