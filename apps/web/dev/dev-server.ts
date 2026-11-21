// Browser development (spec "API와 preload", ARCHITECTURE 3): the Vite dev server
// starts the dev backend with this page's origin allowlisted, proxies /api/ to it on
// the same origin (no CORS), and hands the page its session. The token is read from
// the backend's stdout and kept in memory only; it is never logged or written.
// Dev-only: nothing under src/ imports this file, so no build contains it (V01-R20).
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { InlineConfig, Plugin } from "vite";
import { DEV_SESSION_PATH } from "../src/api.ts";

const HOST = "127.0.0.1";
const DEV_ENTRY = fileURLToPath(new URL("../../../backend/src/dev.ts", import.meta.url));

export interface DevBackendOptions {
  /** Synthetic JSONL replayed by the test Connector (default: the repository's fixtures). */
  fixtures?: string;
  /** Canonical DB folder (default: the dev entry's sibling "PKI-dev"). */
  dataDir?: string;
  /** Extra environment for the dev backend (e.g. the development API key variables). */
  env?: Record<string, string>;
}

/** Starts the dev backend and resolves with its first stdout line: `{ url, token }`. */
export function startBackend(
  args: string[],
  entry = DEV_ENTRY,
  env?: Record<string, string>,
): Promise<{ child: ChildProcess; url: string; token: string }> {
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  // Also when the dev server process ends without closing the server (crash, test worker
  // teardown). Removed once the backend has ended, so restarts do not pile listeners up.
  const kill = () => child.kill();
  process.once("exit", kill);
  child.once("exit", () => process.off("exit", kill));
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`dev backend exited (${code})`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).once("line", (line) => {
      try {
        const { url, token } = JSON.parse(line) as { url: unknown; token: unknown };
        if (typeof url !== "string" || typeof token !== "string") throw new TypeError();
        resolve({ child, url, token });
      } catch {
        // The line is not quoted: it may hold the token.
        child.kill();
        reject(new Error("dev backend printed no session line"));
      }
    });
  });
}

export function devBackend(options: DevBackendOptions, port: number): Plugin {
  const selfHost = `${HOST}:${port}`;
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  return {
    name: "pki-dev-backend",
    apply: "serve",
    async config() {
      backend = await startBackend(
        [
          "--origin",
          `http://${selfHost}`,
          ...(options.fixtures ? ["--fixtures", options.fixtures] : []),
          ...(options.dataDir ? ["--data-dir", options.dataDir] : []),
        ],
        undefined,
        options.env,
      );
      // changeOrigin rewrites Host to the backend's own address, which it requires.
      return { server: { proxy: { "/api/": { target: backend.url, changeOrigin: true } } } };
    },
    configureServer(server) {
      server.httpServer?.once("close", () => backend?.child.kill());
      // Vite's host check runs first and refuses other names for this address (DNS
      // rebinding), so only a page on this origin can read the session (E2E-pinned).
      server.middlewares.use(DEV_SESSION_PATH, (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ baseUrl: "", token: backend?.token }));
      });
    },
  };
}

/** The dev server configuration, shared by vite.config.ts and the browser E2E. */
export function webConfig(options: DevBackendOptions & { port?: number } = {}): InlineConfig {
  const port = options.port ?? 5173;
  return {
    root: fileURLToPath(new URL("..", import.meta.url)),
    // Without CORS, other local pages cannot read the session (Vite allows localhost by default).
    server: { host: HOST, port, strictPort: true, cors: false },
    plugins: [devBackend(options, port)],
  };
}
