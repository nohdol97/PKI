// V01-C4 `artifact.gate` (V01-R10, R20, V01-T15): the production build's backend,
// `backend/shell.js` from the app folder, run by the Electron binary's own Node the
// way the shell's utility process runs it, over the same parent channel (Node fork
// IPC, as shell.channel.test does). Around it everything looks like development:
// development-looking environment variables handed straight to the backend (the
// shell would pass only BACKEND_ENV_KEYS), a CLI whose version is not on the
// verified list on PATH, and a configuration set through the API that a
// development build would act on: the CLI as default with consent, background calls
// on, the unverified warning acknowledged. The connection test with the fixed
// synthetic material is still blocked `cli-not-verified` (a development build would
// run it, marked unverified) and so is the background extraction of imported data
// (a development build: `unverified-background`). No model call reaches the CLI.
// Home's status says so too: the consented default CLI is blocked with the gate's
// reason, not shown as usable (V01-T17 handoff 1, T15 review B-X1).
// The backend takes no switch: `--fixtures` or `--data-dir` stops it before it is
// ready. The whole app (shell + this backend) starts in artifact.shell.e2e.ts;
// Playwright cannot drive it, since it refuses the debugging switches Playwright needs.
import { expect, test } from "@playwright/test";
import { resolveDataDirectory } from "@pki/storage";
import { installFakeCli, send, type FakeCli } from "@pki/testkit";
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_DIR } from "../build/paths.ts";
import { backendEntry } from "../src/backend-entry.ts";
import { ELECTRON } from "../e2e/launch.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const FIXTURES = join(ROOT, "fixtures");
const BACKEND = join(APP_DIR, "backend", "shell.js");

let dir: string;
let cli: FakeCli;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-artifact-gate-"));
  // not on the verified list (empty in the public repository): every version is unlisted
  cli = installFakeCli({ version: "2.1.3" }, dir);
});
test.afterEach(async () => {
  expect(await cli.leftovers()).toEqual([]);
  cli.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** The development-looking environment, the data directory under a temporary HOME. */
function environment() {
  const home = join(dir, "home");
  const xdg = join(dir, "xdg");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {
    PATH: `${cli.bin}:${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_DATA_HOME: xdg,
    TMPDIR: tmpdir(),
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "development",
    [["PKI", "BUILD", "KIND"].join("_")]: "development",
    ELECTRON_IS_DEV: "1",
    DEBUG: "*",
  };
  const dataDir = resolveDataDirectory({ platform: process.platform, home, env });
  return { env, dataDir };
}

function startBackend(args: string[], env: Record<string, string>) {
  const child = fork(BACKEND, args, { execPath: ELECTRON, env, stdio: "pipe" });
  child.on("error", () => undefined); // a send after a refused start: the exit decides
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  return { child, exited, stderr: () => stderr };
}

function ready(child: ChildProcess, token: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    child.on("message", (m: { type?: string; port?: number }) => {
      if (m.type === "ready" && m.port) resolvePort(m.port);
      if (m.type === "failed") reject(new Error("backend failed"));
    });
    child.once("exit", (code) => reject(new Error(`backend exited (${code})`)));
    child.send({ type: "start", token });
  });
}

test("the built backend blocks an unlisted CLI in a development-looking setting", async () => {
  test.skip(process.platform === "win32", "the fake CLI is a shell script (T10 1)");
  test.setTimeout(60_000);
  const { env, dataDir } = environment();
  const token = randomBytes(32).toString("base64url");
  const backend = startBackend(["--origin", "app://pki"], env);
  try {
    const port = await ready(backend.child, token);
    const headers = {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const api = (path: string, body?: unknown) =>
      send(port, path, headers, body === undefined ? "GET" : "POST", body);

    expect((await api("/api/settings")).body).toMatchObject({ dataDirectory: dataDir });
    // no test Connector, in either shape of the repository (I05-R25): neither its instance id nor its kind
    const { connectors } = (await api("/api/connectors")).body as {
      connectors: { id: string; kind: string }[];
    };
    expect(connectors.map((c) => c.id)).not.toContain("fixtures");
    expect(connectors.map((c) => c.kind)).not.toContain("test-fixtures");
    // a public-shaped tree (the build chose the public entry): the three placeholders and nothing else;
    // a fork's registration adds its own instances
    const publicShaped = backendEntry(ROOT) === join(ROOT, "backend/src/shell.ts");
    // the shape is read a second way, so a wrong `backendEntry` cannot switch the exact list off unseen
    expect(publicShaped, "shape").toBe(!existsSync(join(ROOT, "site/composition/package.json")));
    if (publicShaped) {
      expect(connectors.map((c) => c.id).sort()).toEqual([
        "site-mail",
        "site-messenger",
        "site-wiki",
      ]);
    }

    // a configuration a development build would run: the CLI, consented, background on
    expect((await api("/api/providers/default", { providerId: "claude-code" })).status).toBe(200);
    const overview = (await api("/api/consents")).body as {
      policyVersion: string;
      providers: { providerId: string; destination: string | null }[];
    };
    const shown = overview.providers.find((p) => p.providerId === "claude-code");
    const granted = await api("/api/consents", {
      providerId: "claude-code",
      allowedClasses: ["synthetic", "general"],
      destination: shown?.destination ?? "",
      policyVersion: overview.policyVersion,
    });
    expect(granted.status).toBe(200);
    expect((await api("/api/settings/execution", { cliBackground: true })).body).toEqual({
      cliBackground: true,
    });
    expect(((await api("/api/status")).body as { provider: unknown }).provider).toEqual({
      state: "unavailable",
      providerId: "claude-code",
      reason: "cli-not-verified",
    });

    // the user's call on the fixed synthetic material, the unverified warning acknowledged
    expect((await api("/api/connection-test", { acknowledgeUnverified: true })).body).toEqual({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
    });

    // the background call: an import registers extraction jobs the runner calls
    const imported = await api("/api/import/jsonl", {
      text: readFileSync(join(FIXTURES, "v02-mail.jsonl"), "utf8"),
    });
    expect(imported.status).toBe(200);
    await expect
      .poll(async () => {
        const { calls } = (await api("/api/activity")).body as {
          calls: { taskKind: string; outcome: string; reason: string | null }[];
        };
        return calls.filter((c) => c.taskKind === "extract").map((c) => [c.outcome, c.reason]);
      })
      .toContainEqual(["blocked", "cli-not-verified"]);
    expect(cli.modelCalls()).toBe(0);
  } finally {
    if (backend.child.connected) backend.child.send({ type: "stop" });
    expect(await backend.exited).toBe(0);
  }
  expect(existsSync(join(dataDir, "pki.sqlite"))).toBe(true);
});

test.describe("the built backend takes no switch", () => {
  for (const [flag, value] of [
    ["--fixtures", join(FIXTURES, "test-connector.jsonl")],
    ["--data-dir", "switch-data"],
  ] as const) {
    test(`${flag} stops it before it is ready`, async () => {
      const { env, dataDir } = environment();
      const target = value === "switch-data" ? join(dir, value) : value;
      const backend = startBackend(["--origin", "app://pki", flag, target], env);
      await expect(ready(backend.child, randomBytes(32).toString("base64url"))).rejects.toThrow(
        /exited|failed/,
      );
      expect(await backend.exited).not.toBe(0);
      expect(existsSync(join(dir, "switch-data"))).toBe(false);
      expect(existsSync(join(dataDir, "pki.sqlite"))).toBe(false);
    });
  }
});
