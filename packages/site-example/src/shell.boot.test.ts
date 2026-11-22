// I05-C1 ① and C17 `site.example-boot` (I05-R1, R20): the example's own entry files run as a fork's do. The
// entry (`shell.ts`) is started by its path under Node's fork, as the Electron shell starts it: the
// registered kind is listed `ready`, a sync stores the origin's notes, and stop ends the process. The second
// entry (`site-check.ts`) knows the registration's kind. The backend's boot function is not imported:
// a fork's files cannot reach it (the package entry does not export it, and the boundary rule bars a path).
import { routes } from "@pki/contracts";
import { send } from "@pki/testkit";
import { fork, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SHELL = fileURLToPath(new URL("./shell.ts", import.meta.url));
const SITE_CHECK = fileURLToPath(new URL("./site-check.ts", import.meta.url));
const TOKEN = "e".repeat(43);

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-site-example-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("site.example-boot", () => {
  it("the shell entry lists the registered kind ready, a sync stores the origin's notes, and stop ends it", async () => {
    const proc = fork(SHELL, ["--data-dir", join(dir, "data")], {
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    try {
      const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
      const port = await new Promise<number>((resolve, reject) => {
        proc.on("message", (m: { type?: string; port?: number }) => {
          if (m.type === "ready" && m.port) resolve(m.port);
          if (m.type === "failed") reject(new Error("the example failed to start"));
        });
        proc.send({ type: "start", token: TOKEN });
      });
      const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
      const listed = await send(port, routes.connectors.path, headers);
      expect((listed.body as { connectors: unknown[] }).connectors).toEqual(
        expect.arrayContaining([
          { id: "example-notes", kind: "connector-example", state: "ready" },
        ]),
      );
      const synced = await send(port, routes.syncConnector.path, headers, "POST", {
        connectorId: "example-notes",
      });
      expect(synced.body).toMatchObject({ connectorId: "example-notes", created: 2 });
      const sources = await send(port, routes.sources.path, headers);
      expect((sources.body as { sources: { connectorId: string }[] }).sources).toEqual(
        expect.arrayContaining([expect.objectContaining({ connectorId: "example-notes" })]),
      );
      proc.send({ type: "stop" });
      expect(await exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 60_000);

  it("the site-check entry carries the registration: its kind is in the usage list, and the public kinds are still there", () => {
    const run = spawnSync(process.execPath, [SITE_CHECK, "no-such-kind"], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("connector-example");
    expect(run.stderr).toContain("site-mail");
  }, 30_000);
});
