import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const APP_DIR = "PKI";

export interface DataDirectoryInput {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Per-OS-user, non-roaming data directory (V01-R6, ADR 0010). Decided here
 * rather than taken from Electron's userData, which on Windows lives under
 * the roaming %APPDATA%. Sources are recorded in ADR 0010.
 */
export function resolveDataDirectory({ platform, home, env }: DataDirectoryInput): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (!local || !win32.isAbsolute(local)) {
      throw new Error("LOCALAPPDATA is not an absolute path; refusing to guess a data directory");
    }
    return win32.join(local, APP_DIR);
  }
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", APP_DIR);
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".local", "share");
  return posix.join(base, APP_DIR);
}

export function dataDirectory(): string {
  return resolveDataDirectory({ platform: process.platform, home: homedir(), env: process.env });
}
