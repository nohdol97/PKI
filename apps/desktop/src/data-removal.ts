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

const isDirectory = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

export function removeUserData(input: {
  choice: string | undefined;
  /** Called after `keep` is ruled out: keep needs no location, so a location that cannot be worked out is no failure there. */
  dir: () => string;
  lock: (dir: string) => DataLock | undefined;
  disableAutostart: () => void;
}): RemovalResult {
  const { choice } = input;
  if (choice !== "keep" && choice !== "delete") {
    return refuse("--pki-uninstall-data takes keep or delete; nothing was removed");
  }
  try {
    input.disableAutostart();
  } catch (error) {
    // the registration is still on: keep and delete both answer 1 and delete removes nothing (SLF-D2)
    return refuse(
      `could not switch off start at login (${(error as Error).message}); nothing was removed`,
    );
  }
  if (choice === "keep") return { code: 0, line: "" };

  let dir: string;
  try {
    dir = input.dir();
  } catch (error) {
    return refuse(
      `could not work out the data folder (${(error as Error).message}); nothing was removed`,
    );
  }
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
      // SQLite keeps instance.lock-journal open while the lock is held; it goes after close.
      // Only a non-folder is deferred: a folder with that prefix is not SQLite's (SLF-R2).
      if (!name.startsWith(DATA_LOCK_FILE) || isDirectory(join(dir, name)))
        rmSync(join(dir, name), { recursive: true, force: true });
    }
  } catch (error) {
    return refuse(`removal stopped (${(error as Error).message}); the data folder may be partial`);
  } finally {
    try {
      held.close();
    } catch {
      // the process ends soon and the OS frees the lock (SLF-D4)
    }
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
