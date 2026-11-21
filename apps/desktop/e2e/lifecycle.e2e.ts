// The shell owns the backend process (V01-R4): starting the app starts it, quitting
// ends it, and a second launch leaves the first one alone and exits by itself. The
// running backend's argv and environment, read from the OS, carry no session token
// (`shell.channel` on the real Electron utility process). T16 extends this file.
import { expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELECTRON, launchShell, shellArgs } from "./launch.ts";

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

test("start, single instance and quit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pki-lifecycle-"));
  const options = { userData: join(dir, "u"), dataDir: join(dir, "d") };
  const { app, window } = await launchShell(options);
  try {
    await expect(window.getByRole("row", { name: /백엔드/ })).toContainText("준비됨");
    const pids = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .filter((m) => m.type === "Utility" && m.name === "PKI backend")
        .map((m) => m.pid),
    );
    expect(pids).toHaveLength(1);
    const pid = pids[0] as number;
    expect(alive(pid)).toBe(true);

    const { token } = await window.evaluate(() =>
      (window as unknown as { pki: { getSession(): Promise<{ token: string }> } }).pki.getSession(),
    );
    const record = processRecord(pid);
    if (record !== undefined) {
      // Electron hands the entry over its own channel, so the argv names only the service.
      expect(record).toContain("--utility-sub-type=node.mojom.NodeService");
      expect(record).not.toContain(token);
    }

    const second = spawn(ELECTRON, shellArgs(options), { stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));
    expect(code).toBe(0);
    expect(app.windows()).toHaveLength(1);
    await window.getByRole("navigation").getByRole("button", { name: "설정" }).click();
    await expect(window.getByRole("row", { name: /데이터 폴더/ })).toContainText(options.dataDir);

    await app.close();
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
