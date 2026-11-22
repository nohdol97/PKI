// V01-C4 `artifact.gate` (V01-R10, R20, V01-T15): the production build's app folder,
// launched in Electron the way an installed app starts, with everything that looks
// like development around it — development-looking environment variables, the
// source runs' switches, a CLI whose version is not on the verified list on PATH,
// and a configuration a development build would let run (the CLI as default with
// consent, background calls on, the unverified warning acknowledged) — still
// blocks the CLI's user call (the connection test) and its background call (an
// extraction job of imported data) as a production build: `cli-not-verified`,
// where a development build answers `unverified-*`. No model call reaches the CLI.
// The switches are ignored: the canonical DB is in the data directory of the
// (temporary) HOME, nothing is written where the switches point, no test Connector.
// Chromium's own `--user-data-dir` keeps its profile out of the real one (T15 6).
import { _electron, expect, test, type Page } from "@playwright/test";
import { resolveDataDirectory } from "@pki/storage";
import { installFakeCli, type FakeCli } from "@pki/testkit";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ELECTRON } from "../e2e/launch.ts";
import { APP_DIR } from "../build/paths.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");

/** A call to the backend through the shell's app://pki proxy, with the preload's session. */
async function api(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const bridge = (window as unknown as { pki: { getSession(): Promise<{ token: string }> } })
        .pki;
      const { token } = await bridge.getSession();
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    { path, body },
  );
}

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

test("the built app blocks an unlisted CLI in a development-looking setting", async () => {
  test.skip(process.platform === "win32", "the fake CLI is a shell script (T10 1)");
  test.setTimeout(90_000);
  const home = join(dir, "home");
  const xdg = join(dir, "xdg");
  mkdirSync(home);
  const dataDir = resolveDataDirectory({
    platform: process.platform,
    home,
    env: { XDG_DATA_HOME: xdg },
  });
  const switched = { userData: join(dir, "switch-user"), dataDir: join(dir, "switch-data") };

  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [
      APP_DIR,
      `--user-data-dir=${join(dir, "chromium")}`,
      `--pki-user-data=${switched.userData}`,
      `--pki-data-dir=${switched.dataDir}`,
      `--pki-fixtures=${join(FIXTURES, "test-connector.jsonl")}`,
    ],
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      XDG_DATA_HOME: xdg,
      PATH: `${cli.bin}:${process.env.PATH ?? ""}`,
      NODE_ENV: "development",
      [["PKI", "BUILD", "KIND"].join("_")]: "development",
      ELECTRON_IS_DEV: "1",
      DEBUG: "*",
    },
  });
  try {
    const page = await app.firstWindow();
    // the screens and the backend of the app folder answer
    await expect(page.getByRole("navigation")).toBeVisible();
    const settings = await api(page, "/api/settings");
    expect(settings.status).toBe(200);
    expect((settings.body as { dataDirectory: string }).dataDirectory).toBe(dataDir);

    // no test Connector: the site kinds only
    const connectors = (await api(page, "/api/connectors")).body as {
      connectors: { id: string }[];
    };
    expect(connectors.connectors.map((c) => c.id).sort()).toEqual([
      "site-mail",
      "site-messenger",
      "site-wiki",
    ]);

    // a configuration a development build would run: the CLI, consented, background on
    expect((await api(page, "/api/providers/default", { providerId: "claude-code" })).status).toBe(
      200,
    );
    const overview = (await api(page, "/api/consents")).body as {
      policyVersion: string;
      providers: { providerId: string; destination: string | null }[];
    };
    const shown = overview.providers.find((p) => p.providerId === "claude-code");
    const granted = await api(page, "/api/consents", {
      providerId: "claude-code",
      allowedClasses: ["synthetic", "general"],
      destination: shown?.destination ?? "",
      policyVersion: overview.policyVersion,
    });
    expect(granted.status).toBe(200);
    expect((await api(page, "/api/settings/execution", { cliBackground: true })).body).toEqual({
      cliBackground: true,
    });

    // the user's call, the unverified warning acknowledged
    expect((await api(page, "/api/connection-test", { acknowledgeUnverified: true })).body).toEqual(
      { outcome: "blocked", reason: "cli-not-verified", isolation: null },
    );

    // the background call: an import registers extraction jobs the runner calls
    const imported = await api(page, "/api/import/jsonl", {
      text: readFileSync(join(FIXTURES, "v02-mail.jsonl"), "utf8"),
    });
    expect(imported.status).toBe(200);
    await expect
      .poll(async () => {
        const { calls } = (await api(page, "/api/activity")).body as {
          calls: { taskKind: string; outcome: string; reason: string | null }[];
        };
        return calls.filter((c) => c.taskKind === "extract").map((c) => [c.outcome, c.reason]);
      })
      .toContainEqual(["blocked", "cli-not-verified"]);

    expect(cli.modelCalls()).toBe(0);
  } finally {
    await app.close();
  }
  // the switches pointed nowhere the app wrote
  expect(existsSync(switched.userData)).toBe(false);
  expect(existsSync(switched.dataDir)).toBe(false);
  expect(existsSync(join(dataDir, "pki.sqlite"))).toBe(true);
});
