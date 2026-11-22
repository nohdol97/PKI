// I05-T03 (I05-R1, R9, I05-C7 ③): `runShell(site)` under Node's fork, as a fork's own entry file
// calls it: the registration it is given reaches the backend's start, and a registration that stops the
// start posts the one fixed reason and prints the codes and counts, never what the registration wrote.
// The entry files here are written to a temporary folder and import the shell module by its path.
import { routes } from "@pki/contracts";
import { send } from "@pki/testkit";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SHELL_MAIN = pathToFileURL(fileURLToPath(new URL("./shell-main.ts", import.meta.url))).href;
const TOKEN = "k".repeat(43);
const MARKER = "marker-text-that-must-not-leak";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-shell-main-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An entry file that calls runShell with the registration source `registration`. */
function entry(registration: string): string {
  const file = join(dir, "entry.ts");
  writeFileSync(
    file,
    `import { runShell } from ${JSON.stringify(SHELL_MAIN)};
const connector = (type: string) => ({
  manifest: { type, schemaVersion: 2, capabilities: { incremental: false, deletes: false, accessScope: false, fullRescan: false, deletionsOnRescan: false } },
  initialize: async () => {},
  healthCheck: async () => ({ state: "ok" }),
  getChanges: async () => ({ changes: [], nextCursor: null, hasMore: false }),
  getDocument: async () => null,
});
await runShell(${registration});
`,
  );
  return file;
}

function start(file: string) {
  const proc = fork(file, ["--data-dir", join(dir, "data")], {
    env: { PATH: process.env.PATH ?? "", HOME: dir },
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const messages: unknown[] = [];
  const ready = new Promise<void>((resolve) =>
    proc.on("message", (m) => {
      messages.push(m);
      resolve();
    }),
  );
  const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
  proc.send({ type: "start", token: TOKEN });
  return { proc, messages, ready, exited, stderr: () => stderr };
}

describe("runShell(site): a fork's own entry", () => {
  it("a registration that stops the start: the fixed reason is the whole notice, the stderr line has codes and counts only", async () => {
    const run = start(
      entry(
        `{ connectorKinds: { fork: () => connector("fork") }, connectorInstances: [{ id: "mine-${MARKER}", kind: "jsonl-import", config: {} }] }`,
      ),
    );
    const code = await run.exited;
    expect(run.messages).toEqual([{ type: "failed", reason: "site-registration-invalid" }]);
    expect(code).toBe(1);
    const err = run.stderr();
    expect(err).toContain(
      "backend start failed: site-registration-invalid instance-kind-reserved=1\n",
    );
    expect(err).not.toContain(MARKER);
  }, 30_000);

  it("a registration that is fine reaches the backend: its instance is listed ready, and stop ends the process", async () => {
    const run = start(
      entry(
        `{ connectorKinds: { fork: () => connector("fork") }, connectorInstances: [{ id: "fork-1", kind: "fork", config: {} }] }`,
      ),
    );
    await run.ready;
    const message = run.messages[0] as { type: string; port: number };
    expect(message.type).toBe("ready");
    const listed = await send(message.port, routes.connectors.path, {
      host: `127.0.0.1:${message.port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    expect((listed.body as { connectors: unknown[] }).connectors).toEqual(
      expect.arrayContaining([{ id: "fork-1", kind: "fork", state: "ready" }]),
    );
    run.proc.send({ type: "stop" });
    expect(await run.exited).toBe(0);
  }, 30_000);
});
