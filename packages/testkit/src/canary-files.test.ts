import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canariesLeft, findCanaries } from "./canary-files.ts";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-canary-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("canary inspection tool", () => {
  it("finds a canary in the database, a side file and a nested projection path", () => {
    mkdirSync(join(dir, "index", "deep"), { recursive: true });
    writeFileSync(join(dir, "pki.sqlite"), "xx kvzalpha xx");
    writeFileSync(join(dir, "pki.sqlite-journal"), "jwxbeta");
    writeFileSync(join(dir, "index", "deep", "seg"), "pqygamma");
    expect(findCanaries(dir, ["kvzalpha", "jwxbeta", "pqygamma", "absent"])).toEqual([
      { canary: "pqygamma", file: join("index", "deep", "seg") },
      { canary: "kvzalpha", file: "pki.sqlite" },
      { canary: "jwxbeta", file: "pki.sqlite-journal" },
    ]);
  });

  it("finds the lowercased form of a canary an index would store", () => {
    writeFileSync(join(dir, "pki.sqlite"), "qzmword");
    expect(canariesLeft(dir, ["QzmWord", "other"])).toEqual(["QzmWord"]);
  });

  it("reports nothing for a clean directory", () => {
    writeFileSync(join(dir, "pki.sqlite"), "clean");
    expect(canariesLeft(dir, ["kvzalpha"])).toEqual([]);
  });
});
