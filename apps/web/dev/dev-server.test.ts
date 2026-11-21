// The dev backend must not outlive the dev server process, even when that process
// ends without closing the server (a crash or a torn-down test worker).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";

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
