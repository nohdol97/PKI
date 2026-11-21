// The dev entry hands its per-run token to the parent over stdout, never argv or env,
// and opens the canonical DB in the per-user data directory (here under a temp HOME).
import { CANONICAL_DB_FILE } from "./composition.ts";
import { resolveDataDirectory } from "@pki/storage";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { send } from "@pki/testkit";

it("prints a fresh session on stdout and serves the status API with it", async () => {
  const home = mkdtempSync(join(tmpdir(), "pki-dev-home-"));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: join(home, "xdg"),
    LOCALAPPDATA: join(home, "local"),
  };
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "dev.ts")], {
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
    const res = await send(Number(port), "/api/status", {
      host,
      authorization: `Bearer ${session?.token}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ vectorIndex: { state: "unavailable" } });
    const dataDir = resolveDataDirectory({ platform: process.platform, home, env });
    expect(existsSync(join(dataDir, CANONICAL_DB_FILE))).toBe(true);
    const connectors = await send(Number(port), "/api/connectors", {
      host,
      authorization: `Bearer ${session?.token}`,
    });
    expect(connectors.body).toMatchObject({
      connectors: expect.arrayContaining([
        { id: "fixtures", kind: "test-fixtures", state: "ready" },
      ]),
    });
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
