// V01-R6: the data directory is per OS user, never a roaming profile
// location, and the code decides it (not Electron's default userData).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataDirectory, ensureDataDirectory, resolveDataDirectory } from "./data-directory.ts";

describe("resolveDataDirectory", () => {
  it("uses the non-roaming local app data folder on Windows", () => {
    const dir = resolveDataDirectory({
      platform: "win32",
      home: "C:\\Users\\u",
      env: {
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        APPDATA: "C:\\Users\\u\\AppData\\Roaming",
      },
    });
    expect(dir).toBe("C:\\Users\\u\\AppData\\Local\\PKI");
  });

  it("refuses to guess on Windows when LOCALAPPDATA is missing or relative", () => {
    for (const env of [
      { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      { LOCALAPPDATA: "rel\\dir" },
    ]) {
      expect(() => resolveDataDirectory({ platform: "win32", home: "C:\\Users\\u", env })).toThrow(
        /LOCALAPPDATA/,
      );
    }
  });

  it("uses Application Support on macOS", () => {
    expect(resolveDataDirectory({ platform: "darwin", home: "/Users/u", env: {} })).toBe(
      "/Users/u/Library/Application Support/PKI",
    );
  });

  it("uses XDG_DATA_HOME on Linux when it is absolute", () => {
    expect(
      resolveDataDirectory({
        platform: "linux",
        home: "/home/u",
        env: { XDG_DATA_HOME: "/data/u" },
      }),
    ).toBe("/data/u/PKI");
  });

  it("falls back to ~/.local/share on Linux when XDG_DATA_HOME is unset, empty or relative", () => {
    for (const env of [{}, { XDG_DATA_HOME: "" }, { XDG_DATA_HOME: "rel/dir" }]) {
      expect(resolveDataDirectory({ platform: "linux", home: "/home/u", env })).toBe(
        "/home/u/.local/share/PKI",
      );
    }
  });

  it("resolves the current user's directory from the process", () => {
    expect(dataDirectory()).toBe(
      resolveDataDirectory({ platform: process.platform, home: homedir(), env: process.env }),
    );
  });
});

describe.skipIf(process.platform === "win32")("ensureDataDirectory (POSIX)", () => {
  let root: string;
  const mode = (p: string) => statSync(p).mode & 0o777;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pki-data-dir-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates missing directories readable only by the owner", () => {
    const dir = join(root, "a", "PKI");
    ensureDataDirectory(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("repairs an existing directory that others can read", () => {
    const dir = join(root, "PKI");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    ensureDataDirectory(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("refuses a path that is not a directory", () => {
    const file = join(root, "PKI");
    writeFileSync(file, "");
    expect(() => ensureDataDirectory(file)).toThrow(/EEXIST/);
  });
});
