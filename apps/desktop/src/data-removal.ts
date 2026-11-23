// What `--pki-uninstall-data=keep|delete` does (H02A-R6..R9, spec 2026-11-24-H02-common).
// The decision lives here so a test can drive it without Electron; main.ts prints `line`
// and exits with `code`. Delete is the one operation in the product that destroys user
// data, so every guard fails toward keeping: an exact value, a marker that this is a PKI
// data folder, and the data lock (nobody is using it).
import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_IN_USE, DATA_LOCK_FILE, type DataLock } from "./data-lock.ts";

/** The shell switch the installer passes (without the leading dashes). */
export const UNINSTALL_SWITCH = "pki-uninstall-data";

/** Files whose presence says this folder is a PKI data folder. */
const MARKERS = ["pki.sqlite", DATA_LOCK_FILE];

export interface RemovalResult {
  code: 0 | 1;
  /** One line for standard error; empty on success. */
  line: string;
}

const refuse = (line: string): RemovalResult => ({ code: 1, line: `PKI: ${line}` });

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

export function removeUserData(input: {
  choice: string | undefined;
  dir: string;
  lock: (dir: string) => DataLock | undefined;
  disableAutostart: () => void;
}): RemovalResult {
  const { choice, dir } = input;
  if (choice !== "keep" && choice !== "delete") {
    return refuse("--pki-uninstall-data takes keep or delete; nothing was removed");
  }
  input.disableAutostart();
  if (choice === "keep") return { code: 0, line: "" };

  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return { code: 0, line: "" }; // no data folder, nothing to remove
  }
  // a link or a file is not a data folder; never follow one
  if (!stat.isDirectory()) return refuse(`${dir} is not a data folder; nothing was removed`);
  // before the lock: taking it creates instance.lock, which would make the marker vacuous
  if (!MARKERS.some((name) => isFile(join(dir, name)))) {
    return refuse(`${dir} does not look like a PKI data folder; nothing was removed`);
  }
  let held: DataLock | undefined;
  try {
    held = input.lock(dir);
  } catch (error) {
    return refuse(
      `could not lock the data folder (${(error as Error).message}); nothing was removed`,
    );
  }
  if (held === undefined)
    return refuse(`${DATA_IN_USE.replace(/^PKI: /, "")}; nothing was removed`);

  try {
    for (const name of readdirSync(dir)) {
      // SQLite keeps instance.lock-journal open while the lock is held; it goes after close
      if (!name.startsWith(DATA_LOCK_FILE))
        rmSync(join(dir, name), { recursive: true, force: true });
    }
  } catch (error) {
    return refuse(`removal stopped (${(error as Error).message}); the data folder may be partial`);
  } finally {
    held.close();
  }
  try {
    for (const name of readdirSync(dir)) {
      // the lock's own file and SQLite's side files, now unused
      if (name.startsWith(DATA_LOCK_FILE)) rmSync(join(dir, name), { force: true });
    }
    rmdirSync(dir); // not recursive: a PKI that started in the gap keeps its files
  } catch (error) {
    return refuse(`the data folder was not empty at the end (${(error as Error).message})`);
  }
  return { code: 0, line: "" };
}
