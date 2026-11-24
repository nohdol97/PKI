// H02A-C4: what the uninstall switch may delete (spec 2026-11-24-H02-common, R6-R9).
// Real temp folders; the held lock is a second connection in this process.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockDataDirectory } from "./data-lock.ts";
import { removeUserData } from "./data-removal.ts";

let root: string;
let data: string;
let beside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-removal-"));
  data = join(root, "PKI");
  beside = join(root, "beside");
  mkdirSync(data);
  mkdirSync(beside);
  writeFileSync(join(beside, "keep.txt"), "beside");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (choice: string | undefined, dir = data) => {
  const disableAutostart = vi.fn();
  const result = removeUserData({
    choice,
    dir: () => dir,
    lock: lockDataDirectory,
    disableAutostart,
  });
  return { result, disableAutostart };
};
const withDatabase = () => {
  writeFileSync(join(data, "pki.sqlite"), "db");
  mkdirSync(join(data, "sub"));
  writeFileSync(join(data, "sub", "x"), "x");
  symlinkSync(beside, join(data, "link"));
};

describe("removeUserData", () => {
  it("H02A-C4: delete removes the data folder (a link is removed, not followed) and leaves its neighbours", () => {
    withDatabase();
    const { result, disableAutostart } = run("delete");
    expect(result.code).toBe(0);
    expect(existsSync(data)).toBe(false);
    expect(readFileSync(join(beside, "keep.txt"), "utf8")).toBe("beside");
    expect(disableAutostart).toHaveBeenCalledTimes(1);
  });

  it("BGL-C2: a data folder that is itself a link to a PKI-looking folder is refused, and neither the target nor the link is touched", () => {
    const target = join(root, "real");
    mkdirSync(target);
    writeFileSync(join(target, "pki.sqlite"), "db");
    writeFileSync(join(target, "note.txt"), "keep");
    const link = join(root, "link-to-data");
    symlinkSync(target, link);
    const { result } = run("delete", link);
    expect(result.code).toBe(1);
    expect(result.line).toContain("is not a data folder");
    expect(readFileSync(join(target, "pki.sqlite"), "utf8")).toBe("db");
    expect(readFileSync(join(target, "note.txt"), "utf8")).toBe("keep");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("H02A-C4: keep leaves every byte and still switches autostart off", () => {
    withDatabase();
    const { result, disableAutostart } = run("keep");
    expect(result.code).toBe(0);
    expect(readFileSync(join(data, "pki.sqlite"), "utf8")).toBe("db");
    expect(disableAutostart).toHaveBeenCalledTimes(1);
  });

  it("H02A-C4: a missing data folder is success and nothing is created", () => {
    const missing = join(root, "none");
    expect(run("delete", missing).result.code).toBe(0);
    expect(existsSync(missing)).toBe(false);
  });

  it("H02A-C4: a folder another PKI holds is not touched, code 1", () => {
    withDatabase();
    const held = lockDataDirectory(data);
    try {
      const { result, disableAutostart } = run("delete");
      expect(result.code).toBe(1);
      expect(result.line).toMatch(/\S/);
      expect(readFileSync(join(data, "pki.sqlite"), "utf8")).toBe("db");
      expect(disableAutostart).toHaveBeenCalledTimes(1);
    } finally {
      held?.close();
    }
  });

  it("H02A-C4: a folder without pki.sqlite or instance.lock is not touched, code 1", () => {
    writeFileSync(join(data, "report.docx"), "mine");
    const { result } = run("delete");
    expect(result.code).toBe(1);
    expect(readFileSync(join(data, "report.docx"), "utf8")).toBe("mine");
    expect(existsSync(join(data, "instance.lock"))).toBe(false);
  });

  it("H02A-C4: a value other than keep or delete deletes nothing, code 1, autostart untouched", () => {
    withDatabase();
    for (const choice of ["DELETE", "yes", "", undefined]) {
      const { result, disableAutostart } = run(choice);
      expect(result.code, String(choice)).toBe(1);
      expect(disableAutostart).not.toHaveBeenCalled();
    }
    expect(readFileSync(join(data, "pki.sqlite"), "utf8")).toBe("db");
  });

  it("H02A-C4: while the lock is held no instance.lock* file is removed (an open journal cannot be deleted on Windows)", () => {
    withDatabase();
    let journalAtClose: boolean | undefined;
    const lock = (dir: string) => {
      writeFileSync(join(dir, "instance.lock"), "");
      writeFileSync(join(dir, "instance.lock-journal"), "");
      return {
        close: () => {
          journalAtClose = existsSync(join(dir, "instance.lock-journal"));
        },
      };
    };
    const result = removeUserData({
      choice: "delete",
      dir: () => data,
      lock,
      disableAutostart: vi.fn(),
    });
    expect(journalAtClose).toBe(true);
    expect(result.code).toBe(0);
    expect(existsSync(data)).toBe(false);
  });

  it("SLF-C1: a throwing disableAutostart removes nothing and answers 1; a throwing close() does not stop the removal", () => {
    withDatabase();
    const failing = removeUserData({
      choice: "delete",
      dir: () => data,
      lock: lockDataDirectory,
      disableAutostart: () => {
        throw new Error("registry denied");
      },
    });
    expect(failing.code).toBe(1);
    expect(failing.line).toContain("nothing was removed");
    expect(readFileSync(join(data, "pki.sqlite"), "utf8")).toBe("db");
    const closing = removeUserData({
      choice: "delete",
      dir: () => data,
      lock: () => ({
        close: () => {
          throw new Error("already closed");
        },
      }),
      disableAutostart: vi.fn(),
    });
    expect(closing.code).toBe(0);
    expect(existsSync(data)).toBe(false);
  });

  it("SLF-C2: a folder named like the lock file is removed with the rest, code 0", () => {
    withDatabase();
    mkdirSync(join(data, "instance.lock.d"));
    writeFileSync(join(data, "instance.lock.d", "x"), "x");
    const { result } = run("delete");
    expect(result.code).toBe(0);
    expect(existsSync(data)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "LKH-C2: a read-only instance.lock is not a lock: delete refuses and removes nothing, code 1",
    () => {
      withDatabase();
      writeFileSync(join(data, "instance.lock"), "");
      chmodSync(join(data, "instance.lock"), 0o444);
      const { result } = run("delete");
      expect(result.code).toBe(1);
      expect(result.line).toContain("nothing was removed");
      expect(readFileSync(join(data, "pki.sqlite"), "utf8")).toBe("db");
    },
  );

  it("LKH-C5: a data location that cannot be worked out: delete refuses (1), keep still succeeds (0)", () => {
    const noLocation = () => {
      throw new Error("LOCALAPPDATA is not set");
    };
    const call = (choice: string) =>
      removeUserData({
        choice,
        dir: noLocation,
        lock: lockDataDirectory,
        disableAutostart: vi.fn(),
      });
    const refused = call("delete");
    expect(refused.code).toBe(1);
    expect(refused.line).toContain("nothing was removed");
    expect(call("keep").code).toBe(0);
  });
});
