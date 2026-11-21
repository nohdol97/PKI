// The shell owns the backend process (V01-R4): starting the app starts it, quitting
// ends it, and a second launch leaves the first one alone and exits by itself. The
// running backend's environment, read from the OS, carries neither the session token
// nor the shell's own variables (only BACKEND_ENV_KEYS pass, through main.ts's
// utilityProcess wiring). The argv half of `shell.channel` is proven by
// src/shell.channel.test.ts: Electron hands a utility process its entry and arguments
// over its own channel, so the OS-visible argv here names only the service and could
// not show a token either way. Electron itself ends utility processes when the app
// exits, so "no backend after quit" holds even if the backend ignored stop; what the
// quit tests catch is a quit that hangs, live backend or dead. T16 extends this file.
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

test("after the backend dies: no forwarding to its port, and quitting still completes", async () => {
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
    // it here, and the screens' requests must end in the shell (502), never reach it.
    const port = listeningPort(pid);
    process.kill(pid, "SIGKILL");
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
    // Electron drops the process from its metrics when it reports the exit, the same
    // event that clears the shell's forwarding (main.ts); wait for it before asserting.
    await expect.poll(() => backendPids(app), { timeout: 10_000 }).toEqual([]);
    if (port !== undefined) {
      await new Promise<void>((resolve) => impostor.listen(port, "127.0.0.1", resolve));
    }
    const after = await window.evaluate(async () => (await fetch("/api/status")).status);
    expect(after).toBe(502);
    expect(reached).toBe(0);

    // Quitting after the crash must not hang (the quit re-issued from will-quit).
    await app.close();
  } finally {
    impostor.close(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
