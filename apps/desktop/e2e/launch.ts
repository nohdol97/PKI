// Launches the Electron shell for E2E. This is the package's import entry ("."):
// nothing imports the shell at run time (Electron starts package.json "main",
// src/main.ts), so the only importers are the E2E. Test code only; the production
// build refuses it (apps/desktop/build/bundle.ts).
// Each launch gets its own userData folder, so Chromium state and Electron's
// single-instance lock never collide with another test or with an installed app. The
// data folder has its own lock: tests that share one share it deliberately.
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The app folder: its package.json names src/main.ts as Electron's entry. */
export const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
/** In Node, the electron package's export is the path of its binary. */
export const ELECTRON = createRequire(import.meta.url)("electron") as string;

export interface ShellOptions {
  userData: string;
  dataDir?: string;
  fixtures?: string;
  /** Extra environment for the shell process (on top of this process's). */
  env?: Record<string, string>;
}

export function shellArgs({ userData, dataDir, fixtures }: ShellOptions): string[] {
  return [
    DESKTOP_DIR,
    // Chromium's own switch: userData and Electron's single-instance lock (V01-T15 6)
    `--user-data-dir=${userData}`,
    ...(dataDir ? [`--pki-data-dir=${dataDir}`] : []),
    ...(fixtures ? [`--pki-fixtures=${fixtures}`] : []),
  ];
}

export async function launchShell(
  options: ShellOptions,
): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: shellArgs(options),
    ...(options.env ? { env: { ...process.env, ...options.env } as Record<string, string> } : {}),
  });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  return { app, window };
}
