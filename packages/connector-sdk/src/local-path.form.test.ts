// I02B-T02 (I02B-R5, R48; I02B-C37): the path-shape classification is a pure function of the string
// and is tested under the Windows rules on whatever OS runs the tests. What Windows really does with
// these shapes is not claimed here (site-verify, S23 W5, W11).
import { describe, expect, it } from "vitest";
import { classifyPath, PATH_SHAPES, type PathShape } from "./local-path.ts";

/** One example per shape of the I02B-R48 table (plus the two closed-fail shapes this module adds). */
const UNSUPPORTED: Record<PathShape, readonly string[]> = {
  "extended-prefix": [
    String.raw`\\?\C:\a`,
    String.raw`\\.\PhysicalDrive0`,
    String.raw`\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\a`,
    String.raw`\??\C:\a`,
    "//?/C:/a",
  ],
  "drive-relative": ["C:foo", "C:", "c:foo\\bar"],
  "alternate-stream": [String.raw`C:\a\b.md:stream`, String.raw`C:\a:x\b`],
  "short-name": [
    String.raw`C:\PROGRA~1\a`,
    String.raw`C:\Users\NOHDOL~1\Documents`,
    String.raw`C:\a\B~2.TXT`,
  ],
  "trailing-dot-or-space": [String.raw`C:\a.\b`, String.raw`C:\a \b`, String.raw`C:\a\b.`],
  "reserved-device-name": [
    String.raw`C:\CON\x`,
    String.raw`C:\a\nul`,
    String.raw`C:\a\com1.txt`,
    String.raw`C:\LPT9`,
  ],
  "rooted-without-drive": [String.raw`\foo`, "/foo"],
  "control-character": ["C:\\a\u0000b", "C:\\a\nb"],
};

describe("classifyPath under the Windows rules (I02B-C37)", () => {
  it("every shape of the closed list has an example, and the examples name no other shape", () => {
    expect(Object.keys(UNSUPPORTED).sort()).toEqual([...PATH_SHAPES].sort());
  });

  for (const [shape, examples] of Object.entries(UNSUPPORTED)) {
    for (const example of examples) {
      it(`${JSON.stringify(example)} is unsupported-path-form (${shape})`, () => {
        expect(classifyPath(example, "win32")).toEqual({ form: "unsupported-path-form", shape });
      });
    }
  }

  it("UNC paths are network-location, whichever way they are spelled", () => {
    for (const p of [
      String.raw`\\server\share\a`,
      String.raw`\\?\UNC\server\share\a`,
      String.raw`\\.\UNC\server\share`,
      "//server/share/a",
    ]) {
      expect(classifyPath(p, "win32").form, p).toBe("network-location");
    }
  });

  it("a path with a '..' part is not-absolute before any shape is judged", () => {
    for (const p of [String.raw`C:\a\..\b`, "..", "a/../b", String.raw`\\?\C:\a\..\b`]) {
      expect(classifyPath(p, "win32").form, p).toBe("not-absolute");
    }
    expect(classifyPath("/a/../b", "posix").form).toBe("not-absolute");
  });

  it("a relative or empty path is not-absolute", () => {
    for (const p of ["", "docs", String.raw`docs\a`, "./a"]) {
      expect(classifyPath(p, "win32").form, p).toBe("not-absolute");
      expect(classifyPath(p, "posix").form, p).toBe("not-absolute");
    }
  });

  it("an ordinary drive path passes, with spaces, dots inside names and a trailing separator", () => {
    for (const p of [
      String.raw`C:\Users\me\Documents`,
      String.raw`d:\work space\a.b.c\file.tar.gz`,
      "C:\\Users\\me\\Documents\\\\",
      "C:/Users/me/Documents",
      String.raw`C:\a~b\x`,
      String.raw`C:\a\comx`,
      "C:\\",
    ]) {
      expect(classifyPath(p, "win32"), p).toEqual({ form: "ok" });
    }
  });

  it("under the POSIX rules only a path starting with '/' passes; Windows forms are not absolute", () => {
    expect(classifyPath("/Users/me/docs", "posix")).toEqual({ form: "ok" });
    expect(classifyPath("/a/b:c/d.", "posix")).toEqual({ form: "ok" });
    expect(classifyPath("C:\\a", "posix").form).toBe("not-absolute");
    expect(classifyPath("/a\u0000b", "posix")).toEqual({
      form: "unsupported-path-form",
      shape: "control-character",
    });
  });
});
