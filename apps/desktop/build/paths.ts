// Where the production build puts the app folder and its report (V01-T15).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DIST_DIR = resolve(import.meta.dirname, "../dist");
/** The Electron app folder R04 packages. */
export const APP_DIR = join(DIST_DIR, "app");
/** Outside the app folder: not shipped. */
export const REPORT_FILE = join(DIST_DIR, "build-report.json");

export interface BuildReport {
  /**
   * Bundle (path in the app folder) → the repository modules it kept after tree-shaking.
   * Taken before the final dead-code removal, so it may list more than the file has, never less.
   */
  bundles: Record<string, string[]>;
  /** The runtime packages copied into node_modules; `path` is in the app folder. */
  packages: { name: string; version: string; license: string; path: string }[];
}

export function readBuildReport(): BuildReport {
  return JSON.parse(readFileSync(REPORT_FILE, "utf8")) as BuildReport;
}
