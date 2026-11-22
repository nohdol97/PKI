// V01-C2 `shell.channel`: the shell hands the session token to the backend over the
// parent-child channel only. The real backend entry runs here under Node's fork (its
// IPC channel stands in for Electron's utility-process port; both speak the same
// messages), and the running process's own argv and environment are read back from
// the OS to show the token is in neither.
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKEND_ENV_KEYS,
  backendEnv,
  startBackendProcess,
  type Backend,
  type ForkBackend,
} from "./backend-process.ts";

const ENTRY = fileURLToPath(new URL("../../../backend/src/shell.ts", import.meta.url));
const ORIGIN = "app://pki";

/** Node's fork with the same surface as Electron's utilityProcess.fork. */
const nodeFork: ForkBackend = (entry, args, env) => {
  const child = fork(entry, args, {
    env,
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  return {
    get pid() {
      return child.pid;
    },
    postMessage: (message) => void child.send(message as object),
    on: (event, listener) => void child.on(event, listener),
    once: (event, listener) => void child.once(event, (code: number | null) => listener(code ?? 1)),
    kill: () => child.kill(),
    forceKill: () => void child.kill("SIGKILL"),
  };
};

/** What the OS reports as the process's argv and environment. */
function processRecord(pid: number): string | undefined {
  if (process.platform === "linux") {
    return [`/proc/${pid}/cmdline`, `/proc/${pid}/environ`]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
  }
  if (process.platform === "darwin") {
    return execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
  }
  return undefined; // Windows: unverified here (H03)
}

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A throwaway certificate for 127.0.0.1, made per run; nothing of it is kept. */
function selfSignedLoopbackCert(folder: string) {
  const keyFile = join(folder, "loopback-key.pem");
  const file = join(folder, "loopback-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      file,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyFile), cert: readFileSync(file), file };
}

let dir: string;
let backend: Backend | undefined;
const calls: { args: string[]; env: Record<string, string> }[] = [];
const recordingFork: ForkBackend = (entry, args, env) => {
  calls.push({ args, env });
  return nodeFork(entry, args, env);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-shell-channel-"));
  calls.length = 0;
});

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const start = () =>
  startBackendProcess({
    fork: recordingFork,
    entry: ENTRY,
    origin: ORIGIN,
    scopePolicy: undefined,
    dataDir: join(dir, "data"),
    env: { ...process.env, PKI_CANARY_ENV: "leak" },
  });

describe("shell ↔ backend channel", () => {
  it("starts the backend with a fresh token that appears in neither argv nor env", async () => {
    backend = await start();
    expect(backend.token).toMatch(/^[\w-]{43}$/);
    expect(backend.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const ok = await fetch(`${backend.url}/api/status`, {
      headers: { authorization: `Bearer ${backend.token}`, origin: ORIGIN },
    });
    expect(ok.status).toBe(200);
    const otherOrigin = await fetch(`${backend.url}/api/status`, {
      headers: { authorization: `Bearer ${backend.token}`, origin: "https://evil.example" },
    });
    expect(otherOrigin.status).toBe(403);

    const [call] = calls;
    expect(JSON.stringify(call)).not.toContain(backend.token);
    expect(call?.args).toEqual(["--origin", ORIGIN, "--data-dir", join(dir, "data")]);

    const record = processRecord(backend.pid ?? 0);
    if (record !== undefined) {
      expect(record).toContain("shell.ts");
      expect(record).not.toContain(backend.token);
    }
  });

  it("hands over no stored secret at start: not in argv, env or the process record", async () => {
    const canary = `sk-canary-${process.pid}-${Date.now()}`;
    backend = await startBackendProcess({
      fork: recordingFork,
      entry: ENTRY,
      origin: ORIGIN,
      scopePolicy: undefined,
      dataDir: join(dir, "data"),
      secrets: {
        read: async () => ({ state: "present", value: canary }),
        has: async () => ({ ok: true, present: true }),
        deleteOthers: async () => ({ ok: true }),
      },
    });
    expect(JSON.stringify(calls)).not.toContain(canary);
    const record = processRecord(backend.pid ?? 0);
    if (record !== undefined) expect(record).not.toContain(canary);
  });

  // review S5: the real backend asks over the real channel and the shell answers
  it("answers the running backend's presence request for the endpoint host's key", async () => {
    const asked: string[] = [];
    const pruned: string[] = [];
    const keyName = `openai-compatible.api-key.${createHash("sha256")
      .update("one.synthetic.example")
      .digest("hex")
      .slice(0, 32)}`;
    backend = await startBackendProcess({
      fork: recordingFork,
      entry: ENTRY,
      origin: ORIGIN,
      scopePolicy: undefined,
      dataDir: join(dir, "data"),
      secrets: {
        read: async () => ({ state: "unavailable" }),
        has: async (name) => (asked.push(name), { ok: true, present: name === keyName }),
        deleteOthers: async (keep) => (pruned.push(keep), { ok: true }),
      },
    });
    const headers = {
      authorization: `Bearer ${backend.token}`,
      origin: ORIGIN,
      "content-type": "application/json",
    };
    const write = (baseUrl: string) =>
      fetch(`${backend?.url}/api/settings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ openaiCompatible: { baseUrl, model: "synthetic-model" } }),
      }).then((r) => r.json());
    expect(await write("https://one.synthetic.example/v1")).toMatchObject({
      openaiCompatible: { keyName, key: "present" },
    });
    expect(await write("https://two.synthetic.example/v1")).toMatchObject({
      openaiCompatible: { key: "missing" },
    });
    expect(asked[0]).toBe(keyName);
    // each endpoint write first deleted the keys of other hosts, over the same channel
    expect(pruned).toHaveLength(2);
    expect(pruned[0]).toBe(keyName);
  });

  // T11 handoff 2·7, moved to T16: the value (read) over the real channel. The forked
  // backend runs its source as a production build, which sends to `https` only, so
  // the endpoint is a loopback https server whose throwaway certificate this test
  // makes; the test's own fork adds that certificate to the child's trust store
  // (NODE_EXTRA_CA_CERTS, not one of BACKEND_ENV_KEYS: the product never passes it).
  it.skipIf(!hasOpenssl())(
    "answers the running backend's read with the value, which reaches only the endpoint",
    async () => {
      const cert = selfSignedLoopbackCert(dir);
      const seen: { path: string; authorization: string | undefined }[] = [];
      const endpoint = createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => {
        seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              choices: [{ index: 0, message: { role: "assistant", content: '{"reply":"ok"}' } }],
            }),
          );
        });
      });
      await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
      const host = `127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
      const keyName = `openai-compatible.api-key.${createHash("sha256")
        .update(host)
        .digest("hex")
        .slice(0, 32)}`;
      const canary = `sk-canary-read-${process.pid}-${Date.now()}`;
      const asked: string[] = [];
      const trusting: ForkBackend = (entry, args, env) =>
        recordingFork(entry, args, { ...env, NODE_EXTRA_CA_CERTS: cert.file });
      try {
        backend = await startBackendProcess({
          fork: trusting,
          entry: ENTRY,
          origin: ORIGIN,
          scopePolicy: undefined,
          dataDir: join(dir, "data"),
          secrets: {
            read: async (name) => (
              asked.push(`read ${name}`),
              name === keyName ? { state: "present", value: canary } : { state: "missing" }
            ),
            has: async (name) => (
              asked.push(`has ${name}`),
              { ok: true, present: name === keyName }
            ),
            deleteOthers: async () => ({ ok: true }),
          },
        });
        const call = (path: string, body?: unknown) =>
          fetch(`${backend?.url}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              authorization: `Bearer ${backend?.token}`,
              origin: ORIGIN,
              "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }).then((r) => r.json() as Promise<Record<string, unknown>>);
        await call("/api/settings", {
          openaiCompatible: { baseUrl: `https://${host}/v1`, model: "synthetic-model" },
        });
        await call("/api/providers/default", { providerId: "openai-compatible" });
        const { policyVersion } = await call("/api/consents");
        await call("/api/consents", {
          providerId: "openai-compatible",
          allowedClasses: ["synthetic"],
          destination: host,
          policyVersion,
        });
        expect(asked.filter((a) => a.startsWith("read"))).toEqual([]);
        expect(await call("/api/connection-test", { acknowledgeUnverified: false })).toEqual({
          outcome: "ok",
          reason: null,
          isolation: null,
        });
        expect(asked.filter((a) => a.startsWith("read"))).toEqual([`read ${keyName}`]);
        expect(seen).toEqual([{ path: "/v1/chat/completions", authorization: `Bearer ${canary}` }]);
        expect(JSON.stringify(calls)).not.toContain(canary);
      } finally {
        await new Promise((resolve) => {
          endpoint.closeAllConnections();
          endpoint.close(resolve);
        });
      }
    },
  );

  it("passes only the allowlisted environment variables", async () => {
    backend = await start();
    const env = calls[0]?.env ?? {};
    expect(Object.keys(env).every((k) => BACKEND_ENV_KEYS.includes(k))).toBe(true);
    expect(env).not.toHaveProperty("PKI_CANARY_ENV");
    expect(backendEnv({ PATH: "/bin", SECRET: "x", HOME: undefined })).toEqual({ PATH: "/bin" });
  });

  it("gives every run its own token", async () => {
    const first = await start();
    const firstToken = first.token;
    await first.stop();
    backend = await start();
    expect(backend.token).not.toBe(firstToken);
  });

  it("stops the backend process on request", async () => {
    const running = await start();
    const pid = running.pid ?? 0;
    await running.stop();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(fetch(`${running.url}/api/status`)).rejects.toThrow();
  });

  it("rejects when the backend refuses the start message, without echoing it", async () => {
    // A malformed start may still carry the token: the backend answers with the bare
    // failure, nothing of what it received.
    const canary = `${"c".repeat(40)}-canary`;
    const received: unknown[] = [];
    const malformed: ForkBackend = (entry, args, env) => {
      const child = nodeFork(entry, args, env);
      return {
        ...child,
        pid: child.pid,
        on: (event, listener) =>
          child.on(event, (message) => {
            received.push(message);
            listener(message);
          }),
        // An extra field fails the entry's exact message shape.
        postMessage: () => child.postMessage({ type: "start", token: canary, extra: canary }),
      };
    };
    await expect(
      startBackendProcess({
        fork: malformed,
        entry: ENTRY,
        origin: ORIGIN,
        scopePolicy: undefined,
        dataDir: join(dir, "d"),
      }),
    ).rejects.toThrow("backend failed to start");
    expect(received).toEqual([{ type: "failed" }]);
  });
});
