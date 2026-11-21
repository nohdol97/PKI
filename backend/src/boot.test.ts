// The started backend (boot.ts, shared by dev.ts and shell.ts) binds the Broker to
// the connection-test API (V01-R21) and the background setting to the settings API,
// default off (V01-C7 cli-background-default). The product binds no Provider yet,
// so the connection test reports "no-provider" without calling anything.
import { routes } from "@pki/contracts";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";

const TOKEN = "t".repeat(43);
let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("bootBackend", () => {
  it("serves the connection test and the background setting, default off", async () => {
    booted = await bootBackend({ dataDir: dir, token: TOKEN, allowedOrigins: [] });
    const { port } = booted.server;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    const get = (path: string) => send(port, path, headers);
    const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);

    expect((await post(routes.connectionTest.path, { acknowledgeUnverified: true })).body).toEqual({
      outcome: "blocked",
      reason: "no-provider",
      isolation: null,
    });
    expect((await get(routes.executionSettings.path)).body).toEqual({ cliBackground: false });
    expect((await post(routes.setExecutionSettings.path, { cliBackground: true })).body).toEqual({
      cliBackground: true,
    });
    expect((await get(routes.executionSettings.path)).body).toEqual({ cliBackground: true });
    expect((await post(routes.setExecutionSettings.path, { cliBackground: false })).body).toEqual({
      cliBackground: false,
    });
  });
});
