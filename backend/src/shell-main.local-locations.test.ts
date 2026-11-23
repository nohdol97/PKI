// I02B-T03c (I02B-R37, R48; S1, S2): the shell entry run from source under Node's fork. A folder the user
// picked reaches the backend as a `location-ticket` message from the shell; the shell's own user-data folder
// is refused there, one outside it is approved, and a typed path stays refused (a source-run shell is a
// production build kind: only the development entry, dev.ts, takes a typed path).
import { routes } from "@pki/contracts";
import { send } from "@pki/testkit";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SHELL = fileURLToPath(new URL("./shell.ts", import.meta.url));
const TOKEN = "u".repeat(43);

let dir: string;
beforeEach(() => void (dir = realpathSync(mkdtempSync(join(tmpdir(), "pki-shell-loc-")))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the shell's location tickets", () => {
  it("a folder under the shell's user-data folder is refused, one outside is approved, a typed path is refused (S1, S2)", async () => {
    const userData = join(dir, "user");
    const inside = join(userData, "sub");
    const outside = join(dir, "docs");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside);
    const proc = fork(SHELL, ["--data-dir", join(dir, "data"), "--user-data", userData], {
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
    const ready = new Promise<number>((resolve) =>
      proc.on("message", (m) => {
        const message = m as { type: string; port?: number };
        if (message.type === "ready" && message.port) resolve(message.port);
      }),
    );
    proc.send({ type: "start", token: TOKEN });
    try {
      const port = await ready;
      const ticket = (name: string, path: string) => ({
        type: "location-ticket",
        ticket: name.repeat(32),
        kind: "folder",
        path,
      });
      proc.send(ticket("a", inside));
      proc.send(ticket("b", outside));
      const h = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
      const approve = (body: unknown) =>
        send(port, routes.approveLocalLocation.path, h, "POST", body);

      const refused = await approve({ type: "folder", ticket: "a".repeat(32) });
      expect(refused.body).toEqual({ error: "approval-rejected", code: "inside-data-directory" });
      const approved = await approve({ type: "folder", ticket: "b".repeat(32) });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ type: "folder", displayPath: outside });
      const typed = await approve({ type: "folder", path: join(dir, "elsewhere") });
      expect(typed.body).toEqual({ error: "approval-rejected", code: "ticket-required" });

      const listed = await send(port, routes.localLocations.path, h);
      expect((listed.body as { locations: unknown[] }).locations).toHaveLength(1);
    } finally {
      proc.send({ type: "stop" });
      await exited;
    }
  }, 60_000);
});
