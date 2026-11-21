// V01-R6: the data directory is per OS user, never a roaming profile
// location, and the code decides it (not Electron's default userData).
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { dataDirectory, resolveDataDirectory } from "./data-directory.ts";

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
