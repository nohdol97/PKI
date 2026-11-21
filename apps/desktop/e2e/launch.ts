// Launches the Electron shell for E2E. This is the package's import entry ("."):
// nothing imports the shell at run time (Electron starts package.json "main",
// src/main.ts), so the only importer is the screens E2E. Test code only; T15
// keeps it out of the build.
// Each launch gets its own userData folder, so the single-instance lock and Chromium
// state never collide with another test or with an installed app.
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
}

export function shellArgs({ userData, dataDir, fixtures }: ShellOptions): string[] {
  return [
    DESKTOP_DIR,
    `--pki-user-data=${userData}`,
    ...(dataDir ? [`--pki-data-dir=${dataDir}`] : []),
    ...(fixtures ? [`--pki-fixtures=${fixtures}`] : []),
  ];
}

export async function launchShell(
  options: ShellOptions,
): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await _electron.launch({ executablePath: ELECTRON, args: shellArgs(options) });
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  return { app, window };
}
