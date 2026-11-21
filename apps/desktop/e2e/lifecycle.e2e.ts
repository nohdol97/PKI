// The shell owns the backend process (V01-R4): starting the app starts it, quitting
// ends it, and a second launch leaves the first one alone and exits by itself. The
// running backend's environment, read from the OS, carries neither the session token
// nor the shell's own variables (only BACKEND_ENV_KEYS pass, through main.ts's
// utilityProcess wiring). The argv half of `shell.channel` is proven by
// src/shell.channel.test.ts: Electron hands a utility process its entry and arguments
// over its own channel, so the OS-visible argv here names only the service and could
// not show a token either way. Electron itself ends utility processes when the app
// exits, so "no backend after quit" holds even if the backend ignored stop; what the
// quit tests catch is a quit that hangs, live backend or dead. V01-T16: a backend
// that dies is started again (a bounded number of times) at a new address, the old
// port is never forwarded to, and a backend that ignores stop and SIGTERM is
// force-killed so the quit ends within the shell's time limit.
import { expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELECTRON, launchShell, shellArgs, type ShellOptions } from "./launch.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
  return undefined; // Windows: unverified here (H03, R04)
}

/**
 * The loopback port `pid` listens on, read with lsof (macOS, Linux). Undefined where
 * that cannot be read (Windows, or no lsof): the impostor step is then skipped.
 */
function listeningPort(pid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  let out: string;
  try {
    out = execFileSync(
      "lsof",
      ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn", "-P", "-n"],
      {
        encoding: "utf8",
      },
    );
  } catch {
    return undefined;
  }
  const port = Number(/^n127\.0\.0\.1:(\d+)$/m.exec(out)?.[1]);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

type Shell = Awaited<ReturnType<typeof launchShell>>;

/** The one backend utility process Electron reports for this app. */
async function backendPids(app: Shell["app"]): Promise<number[]> {
  return app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((m) => m.type === "Utility" && m.name === "PKI backend")
      .map((m) => m.pid),
  );
}

async function startedShell(options: ShellOptions): Promise<Shell & { pid: number }> {
  const shell = await launchShell(options);
  await expect(shell.window.getByRole("row", { name: /백엔드/ })).toContainText("준비됨");
  const pids = await backendPids(shell.app);
  expect(pids).toHaveLength(1);
  const pid = pids[0] as number;
  expect(alive(pid)).toBe(true);
  return { ...shell, pid };
}

test("start, single instance, and quit with a live backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pki-lifecycle-"));
  const options = { userData: join(dir, "u"), dataDir: join(dir, "d") };
  const { app, window, pid } = await startedShell({ ...options, env: { PKI_CANARY_ENV: "leak" } });
  try {
    const { token } = await window.evaluate(() =>
      (window as unknown as { pki: { getSession(): Promise<{ token: string }> } }).pki.getSession(),
    );
    const record = processRecord(pid);
    if (record !== undefined) {
      // Electron hands the entry over its own channel, so the argv names only the service.
      expect(record).toContain("--utility-sub-type=node.mojom.NodeService");
      expect(record).not.toContain(token);
      expect(record).not.toContain("PKI_CANARY_ENV");
    }

    const second = spawn(ELECTRON, shellArgs(options), { stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));
    expect(code).toBe(0);
    expect(app.windows()).toHaveLength(1);
    // the second launch started no backend of its own, and the first one's is untouched
    expect(await backendPids(app)).toEqual([pid]);
    await window.getByRole("navigation").getByRole("button", { name: "설정" }).click();
    await expect(window.getByRole("row", { name: /데이터 폴더/ })).toContainText(options.dataDir);

    // V01-C3: quitting with the backend running leaves no backend process.
    await app.close();
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The live backend's PID once Electron reports one that is not `previous`. */
async function nextBackend(app: Shell["app"], previous: number): Promise<number> {
  let next = 0;
  await expect
    .poll(
      async () => {
        const pids = await backendPids(app);
        next = pids.length === 1 && pids[0] !== previous ? (pids[0] as number) : 0;
        return next;
      },
      { timeout: 30_000 },
    )
    .not.toBe(0);
  return next;
}

/** /api/status from the page, with the session the page got at load. */
const status = (window: Shell["window"]) =>
  window.evaluate(async () => {
    const { token } = await (
      window as unknown as { pki: { getSession(): Promise<{ token: string }> } }
    ).pki.getSession();
    return (await fetch("/api/status", { headers: { authorization: `Bearer ${token}` } })).status;
  });

test("a backend that dies is restarted at a new address; its old port is never forwarded to", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pki-lifecycle-"));
  const { app, window, pid } = await startedShell({
    userData: join(dir, "u"),
    dataDir: join(dir, "d"),
  });
  let reached = 0;
  const impostor = createServer((_req, res) => {
    reached += 1;
    res.end("{}");
  });
  try {
    // A backend that dies leaves its port to whoever binds it next: an impostor takes
    // it here, and the screens' requests must never reach it.
    const port = listeningPort(pid);
    process.kill(pid, "SIGKILL");
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
    if (port !== undefined) {
      await new Promise<void>((resolve) => {
        impostor.once("error", () => resolve()); // the restarted backend got it first: fine
        impostor.listen(port, "127.0.0.1", resolve);
      });
    }
    const restarted = await nextBackend(app, pid);
    expect(listeningPort(restarted)).not.toBe(port);
    await expect.poll(() => status(window), { timeout: 10_000 }).toBe(200);
    // the page's session still works: the restart kept the run's token
    await window.getByRole("navigation").getByRole("button", { name: "원본" }).click();
    await window.getByRole("navigation").getByRole("button", { name: "홈" }).click();
    await expect(window.getByRole("row", { name: /백엔드/ })).toContainText("준비됨");
    expect(reached).toBe(0);

    await app.close();
    await expect.poll(() => alive(restarted), { timeout: 10_000 }).toBe(false);
  } finally {
    impostor.close(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after the last restart: no forwarding, and quitting still completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pki-lifecycle-"));
  const { app, window, pid } = await startedShell({
    userData: join(dir, "u"),
    dataDir: join(dir, "d"),
  });
  try {
    // the first backend and its three restarts (main.ts MAX_RESTARTS)
    let current = pid;
    for (let restart = 0; restart < 3; restart++) {
      process.kill(current, "SIGKILL");
      current = await nextBackend(app, current);
    }
    process.kill(current, "SIGKILL");
    await expect.poll(() => alive(current), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => backendPids(app), { timeout: 10_000 }).toEqual([]);
    expect(await status(window)).toBe(502);
    // still none a moment later: nothing more is started
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await backendPids(app)).toEqual([]);

    // Quitting after the crash must not hang (the quit re-issued from will-quit).
    await app.close();
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a backend that ignores stop and SIGTERM is force-killed and the quit ends in time", async () => {
  test.skip(process.platform === "win32", "SIGSTOP is POSIX; Windows kill is TerminateProcess");
  const dir = mkdtempSync(join(tmpdir(), "pki-lifecycle-"));
  const { app, pid } = await startedShell({ userData: join(dir, "u"), dataDir: join(dir, "d") });
  try {
    // a stopped process reads no message and leaves SIGTERM pending: only SIGKILL ends it
    process.kill(pid, "SIGSTOP");
    const began = Date.now();
    await app.close();
    // stop 5 s + kill 2 s + force kill (backend-process.ts), with room for a loaded machine
    expect(Date.now() - began).toBeLessThan(15_000);
    await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
