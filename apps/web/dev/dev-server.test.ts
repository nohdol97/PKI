// The dev backend must not outlive the dev server process, even when that process
// ends without closing the server (a crash or a torn-down test worker).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { startBackend } from "./dev-server.ts";

const dir = mkdtempSync(join(tmpdir(), "pki-dev-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function reachable(url: string) {
  return fetch(url).then(
    () => true,
    () => false,
  );
}

it("stops the dev backend when the dev server process exits", async () => {
  const devServer = pathToFileURL(join(import.meta.dirname, "dev-server.ts")).href;
  const script = `
    import { createServer } from "vite";
    const { webConfig } = await import(${JSON.stringify(devServer)});
    const config = webConfig({ port: 0, dataDir: ${JSON.stringify(join(dir, "data"))} });
    const vite = await createServer({ ...config, configFile: false, logLevel: "silent" });
    console.log(vite.config.server.proxy["/api/"].target);
    process.exit(0);
  `;
  // Bare "vite" resolves from apps/web, the -e script's working directory.
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "inherit"],
  });
  let backendUrl = "";
  for await (const line of createInterface({ input: child.stdout })) backendUrl ||= line;
  expect(backendUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  let alive = true;
  for (let i = 0; i < 30 && alive; i++) {
    alive = await reachable(`${backendUrl}/api/status`);
    if (alive) await new Promise((r) => setTimeout(r, 100));
  }
  expect(alive).toBe(false);
});

describe("startBackend", () => {
  const fakeEntry = (name: string, code: string) => {
    const file = join(dir, name);
    writeFileSync(file, code);
    return file;
  };

  it("rejects, without an uncaught error, when the first line is not a session", async () => {
    const entry = fakeEntry(
      "bad-line.mjs",
      'console.log("not json"); setInterval(() => {}, 1000);',
    );
    await expect(startBackend([], entry)).rejects.toThrow("no session line");
  });

  it("rejects a JSON line that is not a session", async () => {
    const entry = fakeEntry(
      "bad-line-shape.mjs",
      'console.log("{}"); setInterval(() => {}, 1000);',
    );
    await expect(startBackend([], entry)).rejects.toThrow("no session line");
  });

  it("rejects a session line without a token", async () => {
    const entry = fakeEntry(
      "bad-line-no-token.mjs",
      'console.log(JSON.stringify({ url: "u" })); setInterval(() => {}, 1000);',
    );
    await expect(startBackend([], entry)).rejects.toThrow("no session line");
  });

  it("rejects when the backend exits before printing", async () => {
    await expect(startBackend([], fakeEntry("exit.mjs", "process.exit(3);"))).rejects.toThrow(
      "exited (3)",
    );
  });

  it("drops its process exit hook once the backend has ended", async () => {
    const before = process.listenerCount("exit");
    const entry = fakeEntry("ok.mjs", 'console.log(JSON.stringify({ url: "u", token: "t" }));');
    const { child } = await startBackend([], entry);
    if (child.exitCode === null) await new Promise((r) => child.once("exit", r));
    expect(process.listenerCount("exit")).toBe(before);
  });
});
