// I02B-C50 `artifact.normalizer` (I02B-R22, G20, G21): the normalizer host's spawn adapter ⓑ in a bundled
// test app. The app is bundled with the production bundler settings from the real shell code
// (`startBackendProcess`, the host broker), the backend's real adapter file, the real host and worker and
// a test worker, and started with the repository build's Electron binary. The `RunAsNode` fuse is on in
// that binary, so a host started with `child_process.fork` would work too: the test therefore reads
// what the host says it is (`process.type` and the kind of its parent), and a fork host fails it.
// Not covered: the installer with the fuse off, and Windows (G22, S23 W9).
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "../build/bundle.ts";
import { APP_DIR } from "../build/paths.ts";
import { ELECTRON } from "../e2e/launch.ts";

const TEST_APP = join(APP_DIR, "..", "normalizer-app");
const ENTRIES = [
  ["apps/desktop/artifact/normalizer-main.ts", "main.js"],
  ["backend/src/normalizer-stand-in.test-support.ts", "backend/stand-in.js"],
  ["packages/document-normalize/src/host.ts", "backend/host.js"],
  ["packages/document-normalize/src/testing/test-host.ts", "backend/test-host.js"],
  ["packages/document-normalize/src/isolated-worker.ts", "backend/isolated-worker.js"],
  ["packages/document-normalize/src/testing/bomb-worker.ts", "backend/bomb-worker.js"],
] as const;
const TEST_ONLY = [
  "apps/desktop/artifact/normalizer-main.ts",
  "packages/document-normalize/src/testing/test-host.ts",
  "packages/document-normalize/src/testing/bomb-worker.ts",
  "packages/document-normalize/src/testing/time-bombs.ts",
  "packages/document-normalize/src/testing/ooxml-builder.ts",
  "backend/src/normalizer-stand-in.test-support.ts",
];

type Record = { type: string; [key: string]: unknown };
interface Run {
  records: Record[];
  code: number | null;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  rmSync(TEST_APP, { recursive: true, force: true });
  mkdirSync(TEST_APP, { recursive: true });
  for (const [input, output] of ENTRIES) {
    await bundle({
      input,
      outFile: join(TEST_APP, output),
      buildKind: "test",
      allowTestOnly: TEST_ONLY,
    });
  }
  writeFileSync(
    join(TEST_APP, "package.json"),
    JSON.stringify({ name: "pki-normalizer-test-app", type: "module", main: "main.js" }),
  );
});
test.afterAll(() => rmSync(TEST_APP, { recursive: true, force: true }));

/** Runs the test app on a scenario; the reports are the lines `T {json}` on its stdout. */
async function run(scenario: string, timeoutMs = 90_000): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "pki-normalizer-app-"));
  const child = spawn(
    ELECTRON,
    [TEST_APP, `--user-data-dir=${join(dir, "chromium")}`, `--scenario=${scenario}`],
    {
      env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", () => undefined);
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  rmSync(dir, { recursive: true, force: true });
  const records = out
    .split("\n")
    .filter((l) => l.startsWith("T "))
    .map((l) => JSON.parse(l.slice(2)) as Record);
  console.log(
    `[${scenario}] exit=${code}\n${records.map((r) => JSON.stringify(r).slice(0, 600)).join("\n")}`,
  );
  return { records, code };
}
const find = (run: Run, type: string) => run.records.find((r) => r.type === type);
const all = (run: Run, type: string) => run.records.filter((r) => r.type === type);

test("the backend asks the shell, the shell starts the host as a utility process, one file is normalized, the host ends", async () => {
  test.setTimeout(120_000);
  const r = await run("basic");
  expect(r.code).toBe(0);
  const markdown = find(r, "markdown") as Record & {
    viaHost: unknown;
    direct: unknown;
    hello: { processType: string; parentKind: string };
  };
  // ② the same result as a direct call
  expect(markdown.viaHost).toEqual(markdown.direct);
  expect((markdown.viaHost as { ok: boolean }).ok).toBe(true);
  // the path: a utility process whose parent is Electron's main process, not a Node fork
  expect(markdown.hello).toMatchObject({ processType: "utility", parentKind: "electron-main" });
  // ③ a loop in the worker: timed-out, within the host's clock plus the backstop
  const loop = find(r, "loop") as Record & { result: { code: string }; ms: number };
  expect(loop.result.code).toBe("timed-out");
  expect(loop.ms).toBeLessThan(3_500);
  // ④ the next job runs on a new host, and the first host process is gone
  expect(find(r, "hosts-gone")).toMatchObject({ live: 0 });
  expect((find(r, "hosts-gone") as Record & { ms: number }).ms).toBeLessThan(3_000);
  expect(find(r, "after-loop")).toMatchObject({ ok: true, hellos: 2 });
  const hosts = find(r, "hosts") as Record & { pids: number[] };
  expect(hosts.pids).toHaveLength(2);
  // two different processes, both known by pid
  expect(hosts.pids.every((pid) => Number.isInteger(pid))).toBe(true);
  expect(hosts.pids[0]).not.toBe(hosts.pids[1]);
  // ⑤ the backend ends: so does the host
  expect(find(r, "after-backend")).toMatchObject({ how: "stop", liveHosts: 0 });
});

test("the path check tells a shell-started host from a child_process.fork host in the same binary", async () => {
  test.setTimeout(120_000);
  const r = await run("fork-control");
  const control = find(r, "fork-control") as Record & {
    hello: { processType: string | null; parentKind: string } | null;
  };
  // the binary lets a utility process fork Node children (the fuse is on): such a host says so
  expect(control.hello).toMatchObject({ parentKind: "node-ipc" });
  expect(control.hello?.processType).not.toBe("utility");
});

test("the product's worker file is bundled and runs in the host", async () => {
  test.setTimeout(120_000);
  const r = await run("product-worker");
  const markdown = find(r, "markdown") as Record & { viaHost: unknown; direct: unknown };
  expect(markdown.viaHost).toEqual(markdown.direct);
  expect((markdown.viaHost as { ok: boolean }).ok).toBe(true);
  // the shell passed the host no arguments at all
  const hosts = find(r, "hosts") as Record & { forks: { args: string[]; env: object }[] };
  expect(hosts.forks).toHaveLength(1);
  expect(hosts.forks[0]).toMatchObject({ args: [], env: {} });
});

test("a host killed from outside mid-job is retried once; killed again, resource-exceeded; the next job has a new host", async () => {
  test.setTimeout(120_000);
  const r = await run("kill-mid-job");
  expect(find(r, "killed-twice")).toMatchObject({
    result: { ok: false, code: "resource-exceeded", unexplainedDeath: true },
    hosts: 2,
  });
  expect(find(r, "after-kill")).toMatchObject({ ok: true, hosts: 3 });
  expect(all(r, "killed")).toHaveLength(2);
});

test("100 requests in a row leave at most one live host", async () => {
  test.setTimeout(180_000);
  const r = await run("flood", 170_000);
  const flood = find(r, "flood") as Record & { resolved: number; rejected: number };
  expect(flood.resolved + flood.rejected).toBe(100);
  expect(flood.resolved).toBeGreaterThanOrEqual(1);
  const hosts = find(r, "hosts") as Record & { maxLive: number };
  expect(hosts.maxLive).toBeLessThanOrEqual(1);
  expect(hosts.maxLive).toBeGreaterThanOrEqual(1);
  expect(find(r, "after-backend")).toMatchObject({ liveHosts: 0 });
});

test("the shell takes nothing but a number from a request, and starts only the bundled host entry", async () => {
  test.setTimeout(120_000);
  const r = await run("bad-requests");
  expect(find(r, "bad-requests-sent")).toBeDefined();
  expect(find(r, "proper-request")).toMatchObject({ ok: true });
  const hosts = find(r, "hosts") as Record & {
    spawned: number;
    forks: { entry: string; args: string[]; env: object }[];
  };
  // seven bad requests started nothing; the one proper request started one
  expect(hosts.spawned).toBe(1);
  expect(hosts.forks).toHaveLength(1);
  expect(hosts.forks[0]?.entry.endsWith("backend/host.js")).toBe(true);
  expect(hosts.forks[0]?.args).toEqual([]);
  expect(hosts.forks[0]?.env).toEqual({});
  expect(JSON.stringify(hosts.forks)).not.toMatch(/\/bin\/sh|--inspect|"A"/);
});

test("a backend killed from outside leaves no host", async () => {
  test.setTimeout(120_000);
  const r = await run("backend-kill");
  expect(find(r, "host-up")).toBeDefined();
  expect(find(r, "after-backend")).toMatchObject({ how: "kill-backend", liveHosts: 0 });
});

test("a heap-filling worker at a small heap limit ends as resource-exceeded and the backend lives (G21)", async () => {
  test.setTimeout(180_000);
  const r = await run("heap-fill", 170_000);
  const fill = find(r, "heap-fill") as Record & {
    result: { code: string; unexplainedDeath: boolean };
    ms: number;
  };
  expect(fill.result.code).toBe("resource-exceeded");
  expect(find(r, "after-heap-fill")).toMatchObject({ ok: true });
  // G21: whether V8 aborted the whole host (a death without a word) or only the worker ended
  console.log(
    `G21: heap-fill at 128 MB ended ${fill.result.unexplainedDeath ? "with the host aborted (no word, retried)" : "with the worker ended by itself (the host reported it)"} in ${fill.ms} ms`,
  );
});

test("G23: the trigger XLSX's heap use inside Electron's V8 is recorded", async () => {
  test.skip(
    process.env.PKI_SLOW_E2E === undefined,
    "measurement (I02 G23, 156 s): run with PKI_SLOW_E2E=1",
  );
  test.setTimeout(300_000);
  const r = await run("g23", 280_000);
  const rows = all(r, "g23");
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row.outcome).toMatch(/finished-ok|error:/);
});
