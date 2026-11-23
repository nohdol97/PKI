// Runs pnpm without a shell (review B-F2). Under a pnpm script `npm_execpath` names
// pnpm's own entry: a JavaScript file runs on this Node, anything else (an
// executable) runs as it is. Without it, `pnpm` is looked up on PATH, which on
// Windows is a `.cmd` Node does not start without a shell: there the build must run
// through pnpm (`pnpm --filter @pki/desktop build`). Windows is not verified (R04).
import { execFileSync } from "node:child_process";

export function pnpmCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  const entry = env.npm_execpath;
  if (entry && /\.[cm]?js$/.test(entry)) return { file: process.execPath, args: [entry] };
  if (entry) return { file: entry, args: [] };
  if (platform === "win32") {
    throw new Error(
      "run this through pnpm (`pnpm --filter @pki/desktop build`): npm_execpath is not set",
    );
  }
  return { file: "pnpm", args: [] };
}

export function pnpm(args: readonly string[], cwd: string): void {
  const command = pnpmCommand();
  execFileSync(command.file, [...command.args, ...args], { cwd, stdio: "inherit" });
}

/** Like `pnpm`, but returns what the command wrote to standard output. */
export function pnpmOutput(args: readonly string[], cwd: string): string {
  const command = pnpmCommand();
  return execFileSync(command.file, [...command.args, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}
