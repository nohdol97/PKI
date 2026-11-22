// start.identity-key-text (I04-R7): the real `shell.ts` under Node's fork, as the
// desktop shell starts it, against a data directory whose hashed sources lost the
// identity key. It posts the fixed class and exits: no error text crosses the channel.
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb } from "./composition.ts";

const ENTRY = fileURLToPath(new URL("./shell.ts", import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-shell-key-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("start.identity-key-text: the shell's report of a refused start", () => {
  it("posts only the fixed reason when hashed sources lost the identity key", async () => {
    const data = join(dir, "data");
    const db = openCanonicalDb(data);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id, identity_hashed) VALUES ('c', 'h', 'h', 1)",
    );
    db.run("DELETE FROM identity_key");
    db.close();
    const proc = fork(ENTRY, ["--data-dir", data], {
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const messages: unknown[] = [];
    proc.on("message", (m) => messages.push(m));
    const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
    proc.send({ type: "start", token: "k".repeat(43) });
    const code = await exited;
    expect(messages).toEqual([{ type: "failed", reason: "identity-key-missing" }]);
    expect(code).toBe(1);
  }, 30_000);
});
