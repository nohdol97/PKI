// #181 R2: dirTemplate builds one directory per test file and hands out private copies.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dirTemplate } from "./db-template.ts";

let builds = 0;
let builtAt = "";
const copyOf = dirTemplate((dir) => {
  builds += 1;
  builtAt = dir;
  writeFileSync(join(dir, "seed.txt"), "seeded");
});

const roots: string[] = [];
const target = (): string => {
  const root = mkdtempSync(join(tmpdir(), "pki-testkit-dirtemplate-"));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("dirTemplate", () => {
  it("builds once and gives each copy the built state without sharing writes", () => {
    const a = target();
    const b = target();
    copyOf(a);
    copyOf(b);
    expect(builds).toBe(1);
    expect(readFileSync(join(a, "seed.txt"), "utf8")).toBe("seeded");
    expect(readFileSync(join(b, "seed.txt"), "utf8")).toBe("seeded");
    writeFileSync(join(a, "seed.txt"), "changed");
    writeFileSync(join(a, "extra.txt"), "only in a");
    expect(readFileSync(join(b, "seed.txt"), "utf8")).toBe("seeded");
    expect(existsSync(join(b, "extra.txt"))).toBe(false);
    expect(existsSync(builtAt)).toBe(true);
  });
});
