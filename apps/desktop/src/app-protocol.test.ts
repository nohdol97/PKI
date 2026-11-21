// The Electron screens load from app://pki (never file://, whose Origin is "null"):
// built files with the CSP from WEB_ROOT, and /api/ forwarded to the backend on the
// same origin, so no CORS is needed and the backend's Origin allowlist holds one value.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, CONTENT_SECURITY_POLICY, createAppHandler } from "./app-protocol.ts";

let dir: string;
let webRoot: string;
let backendUrl: string;
let closeBackend: () => void;
const seen: {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-app-protocol-"));
  webRoot = join(dir, "dist");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>PKI</title>");
  writeFileSync(join(webRoot, "assets", "index.js"), "console.log(1)");
  writeFileSync(join(dir, "secret.js"), "outside the web root");
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(201, { "content-type": "application/json", "set-cookie": "x=1" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  backendUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeBackend = () => server.close();
});

afterAll(() => {
  closeBackend();
  rmSync(dir, { recursive: true, force: true });
});

const handler = () => createAppHandler({ webRoot, backendUrl, backendAlive: () => true });
const get = (path: string, init?: RequestInit) =>
  handler()(new Request(`${APP_ORIGIN}${path}`, init));

describe("app protocol", () => {
  it("serves the built page with the CSP", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(await res.text()).toContain("<title>PKI</title>");
    const js = await get("/assets/index.js");
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("allows only its own scripts, styles and connections", () => {
    const directives = new Map(
      CONTENT_SECURITY_POLICY.split(";").map((d) => {
        const [name = "", ...values] = d.trim().split(/\s+/);
        return [name, values.join(" ")];
      }),
    );
    expect(directives.get("default-src")).toBe("'none'");
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("connect-src")).toBe("'self'");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-|\*|https?:/);
  });

  it.each(["/%2e%2e/secret.js", "/assets/%2e%2e/%2e%2e/secret.js", "/..%2fsecret.js"])(
    "never reads outside the web root: %s",
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("outside the web root");
    },
  );

  it("answers 404 for missing files and unknown file types", async () => {
    expect((await get("/missing.js")).status).toBe(404);
    writeFileSync(join(webRoot, "data.bin"), "x");
    expect((await get("/data.bin")).status).toBe(404);
  });

  it("refuses other hosts of the scheme and non-read methods on files", async () => {
    expect((await handler()(new Request("app://evil/"))).status).toBe(403);
    expect((await get("/", { method: "POST", body: "x" })).status).toBe(405);
  });

  it("forwards /api/ to the backend with the app origin and only the needed headers", async () => {
    seen.length = 0;
    const res = await get("/api/sources/search?x=1", {
      method: "POST",
      headers: {
        authorization: "Bearer abc",
        "content-type": "application/json",
        cookie: "c=1",
        origin: "https://evil.example",
        "x-other": "1",
      },
      body: '{"query":"등대"}',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toBeNull();
    const [call] = seen;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("/api/sources/search?x=1");
    expect(call?.body).toBe('{"query":"등대"}');
    expect(call?.headers.origin).toBe(APP_ORIGIN);
    expect(call?.headers.authorization).toBe("Bearer abc");
    expect(call?.headers.host).toBe(new URL(backendUrl).host);
    expect(call?.headers.cookie).toBeUndefined();
    expect(call?.headers["x-other"]).toBeUndefined();
  });

  // Once the backend has exited, its port can be taken by any local process (another
  // OS user's included): nothing, token and body least of all, is sent there.
  it("stops forwarding once the backend has exited, even if the port answers again", async () => {
    seen.length = 0;
    let alive = true;
    const forwarder = createAppHandler({ webRoot, backendUrl, backendAlive: () => alive });
    const call = () =>
      forwarder(
        new Request(`${APP_ORIGIN}/api/settings`, {
          method: "POST",
          headers: { authorization: "Bearer abc" },
          body: "{}",
        }),
      );
    expect((await call()).status).toBe(201);
    alive = false;
    const res = await call();
    expect(res.status).toBe(502);
    expect(seen).toHaveLength(1);
  });

  it("answers 502 when the backend cannot be reached", async () => {
    const down = createAppHandler({
      webRoot,
      backendUrl: "http://127.0.0.1:1",
      backendAlive: () => true,
    });
    const res = await down(new Request(`${APP_ORIGIN}/api/status`));
    expect(res.status).toBe(502);
  });
});
