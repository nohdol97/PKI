// Backend shutdown through the shell entry (V01-T10 handoff 7; review A-D3): the real
// `shell.ts` runs under Node's fork, as the shell starts it, with a fake CLI on its
// PATH whose version query hangs, ignores SIGTERM and leaves a grandchild. A
// connection test starts that query; "stop" must end the whole CLI tree before the
// backend exits (closeProviders in stop()), though the tree runs in its own process
// group and would otherwise outlive the backend. The data directory's run root is
// left empty too.
import { routes } from "@pki/contracts";
import { installFakeCli, send, type FakeCli } from "@pki/testkit";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("./shell.ts", import.meta.url));
const TOKEN = "s".repeat(43);

let dir: string;
let fake: FakeCli;
let child: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-shell-stop-"));
  fake = installFakeCli({ versionMode: "hang", auth: "logged-in" });
});
afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  // leak check: what the backend left is killed here, and fails the test
  expect(await fake.leftovers()).toEqual([]);
  fake.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function start(): Promise<{ port: number; exited: Promise<number | null> }> {
  const proc = fork(ENTRY, ["--data-dir", join(dir, "data")], {
    env: { PATH: fake.bin, HOME: dir },
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  child = proc;
  const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
  return new Promise((resolve, reject) => {
    proc.on("message", (m: { type?: string; port?: number }) => {
      if (m.type === "ready" && m.port) resolve({ port: m.port, exited });
      if (m.type === "failed") reject(new Error("backend failed to start"));
    });
    proc.send({ type: "start", token: TOKEN });
  });
}

describe("shell entry: stop", () => {
  it("ends a CLI query tree still running before the backend exits", async () => {
    const { port, exited } = await start();
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);
    await post(routes.setDefaultProvider.path, { providerId: "codex" });
    const { policyVersion } = (await send(port, routes.consents.path, headers)).body as {
      policyVersion: string;
    };
    await post(routes.grantConsent.path, {
      providerId: "codex",
      allowedClasses: ["synthetic"],
      destination: "vendor:codex",
      policyVersion,
    });
    // consented: the Broker queries the CLI's version, which hangs
    void post(routes.connectionTest.path, { acknowledgeUnverified: false }).catch(() => undefined);
    const end = Date.now() + 15_000;
    while (fake.spawned().length === 0 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fake.spawned()).toHaveLength(1);

    child?.send({ type: "stop" });
    expect(await exited).toBe(0);
    // gone by the time the backend exited: nothing to wait for
    expect(await fake.leftovers(0)).toEqual([]);
    expect(readdirSync(join(dir, "data", "cli-runs"))).toEqual([]);
  }, 60_000);
});
