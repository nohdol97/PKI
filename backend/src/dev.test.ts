// The dev entry hands its per-run token to the parent over stdout, never argv or env,
// and keeps its DB apart from the product's: a sibling "PKI-dev" folder by default
// (here under a temp HOME), or --data-dir. --fixtures picks the synthetic seed file.
import { CANONICAL_DB_FILE } from "./composition.ts";
import { resolveDataDirectory } from "@pki/storage";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { send } from "@pki/testkit";

// Every test here starts real processes. Slowest test, 5 runs alone: 0.41 s; 10 runs with the machine
// 3x oversubscribed (24 busy loops on 8 cores): 3.0 s. 30 s is about 5x the loaded worst case.
vi.setConfig({ testTimeout: 30_000 });

let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pki-dev-home-"));
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: join(home, "xdg"),
    LOCALAPPDATA: join(home, "local"),
  };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Starts dev.ts, runs `check` against its session, then stops it. */
async function withDev(
  args: string[],
  check: (port: number, headers: Record<string, string>) => Promise<void>,
) {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "dev.ts"), ...args], {
    stdio: ["ignore", "pipe", "inherit"],
    env,
  });
  try {
    const sessions: { url: string; token: string }[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      sessions.push(JSON.parse(line));
      break;
    }
    const session = sessions[0];
    expect(session?.token).toMatch(/^[\w-]{43}$/);
    const { host, port } = new URL(session?.url ?? "");
    await check(Number(port), { host, authorization: `Bearer ${session?.token}` });
  } finally {
    child.kill();
  }
}

const productDir = () => resolveDataDirectory({ platform: process.platform, home, env });

it("prints a fresh session on stdout and serves the API from a separate dev DB", async () => {
  await withDev([], async (port, headers) => {
    const res = await send(port, "/api/status", headers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ vectorIndex: { state: "unavailable" } });
    const connectors = await send(port, "/api/connectors", headers);
    expect(connectors.body).toMatchObject({
      connectors: expect.arrayContaining([
        { id: "fixtures", kind: "test-fixtures", state: "ready" },
      ]),
    });
  });
  expect(existsSync(join(`${productDir()}-dev`, CANONICAL_DB_FILE))).toBe(true);
  expect(existsSync(productDir())).toBe(false);
});

it("uses --data-dir when given", async () => {
  const dir = join(home, "chosen");
  await withDev(["--data-dir", dir], async (port, headers) => {
    expect((await send(port, "/api/status", headers)).status).toBe(200);
  });
  expect(existsSync(join(dir, CANONICAL_DB_FILE))).toBe(true);
  expect(existsSync(`${productDir()}-dev`)).toBe(false);
  expect(existsSync(productDir())).toBe(false);
});

it("seeds the test Connector from --fixtures and reports its data directory", async () => {
  const dir = join(home, "seeded");
  const fixtures = join(home, "seed.jsonl");
  writeFileSync(
    fixtures,
    `${JSON.stringify({ externalId: "s1", title: "합성 씨앗", body: "b" })}\n`,
  );
  await withDev(["--data-dir", dir, "--fixtures", fixtures], async (port, headers) => {
    const sync = await send(port, "/api/connectors/sync", headers, "POST", {
      connectorId: "fixtures",
    });
    expect(sync.body).not.toHaveProperty("stopped");
    expect(sync.body).toMatchObject({
      connectorId: "fixtures",
      received: 1,
      created: 1,
    });
    expect((await send(port, "/api/sources", headers)).body).toMatchObject({
      sources: [{ externalId: "s1", title: "합성 씨앗" }],
    });
    expect((await send(port, "/api/settings", headers)).body).toMatchObject({
      dataDirectory: dir,
    });
  });
});
