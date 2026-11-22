// V01-R7 synthetic manifest: a build resource holding, for every synthetic item
// in the repository, one hash binding title and body, with malicious variants
// flagged. Nothing at runtime (data folder, environment, settings) can extend it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import committed from "./synthetic-manifest.json" with { type: "json" };
import { buildSyntheticManifest, manifestIsCurrent } from "./build-synthetic-manifest.ts";
import * as manifest from "./synthetic-manifest.ts";
import { lookupSynthetic, syntheticHash } from "./synthetic-manifest.ts";

const root = resolve(import.meta.dirname, "../..");

function jsonl(path: string): Record<string, unknown>[] {
  return readFileSync(resolve(root, path), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const fixtures = jsonl("fixtures/test-connector.jsonl") as {
  title: string;
  body: string;
  malicious?: boolean;
}[];
function first(predicate: (f: (typeof fixtures)[number]) => boolean) {
  const found = fixtures.find(predicate);
  if (!found) throw new Error("fixtures need both a plain and a malicious record");
  return found;
}
const plain = first((f) => !f.malicious);
const malicious = first((f) => f.malicious === true);
const material = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "connection-test-material.json"), "utf8"),
);

describe("build", () => {
  it("the committed manifest equals a fresh build from the repository", () => {
    expect(committed).toEqual(buildSyntheticManifest(root));
  });

  // the production build runs this check and stops on a stale list (V01-T15, T04 ①)
  describe("check command", () => {
    const script = resolve(import.meta.dirname, "build-synthetic-manifest.ts");
    const check = (...args: string[]) =>
      spawnSync(process.execPath, [script, "--check", ...args], { encoding: "utf8" });
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "pki-manifest-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("passes on the committed manifest", () => {
      expect([check().status, check().stderr]).toEqual([0, ""]);
    });

    it("fails on a list that differs from a fresh build, and rewrites nothing", () => {
      const stale = join(dir, "synthetic-manifest.json");
      const text = `${JSON.stringify(committed.slice(1), null, 2)}\n`;
      writeFileSync(stale, text);
      const run = check(stale);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/synthetic manifest is stale/);
      expect(readFileSync(stale, "utf8")).toBe(text);
      expect(manifestIsCurrent(root, stale)).toBe(false);
    });

    it("passes on a list equal to a fresh build", () => {
      const fresh = join(dir, "synthetic-manifest.json");
      writeFileSync(fresh, `${JSON.stringify(buildSyntheticManifest(root), null, 2)}\n`);
      expect(check(fresh).status).toBe(0);
      expect(manifestIsCurrent(root, fresh)).toBe(true);
    });
  });

  it("covers every fixture record, golden source and the connection-test material", () => {
    for (const f of fixtures) expect(lookupSynthetic(f.title, f.body)).toBeDefined();
    for (const name of ["mail", "messenger", "wiki"]) {
      for (const g of jsonl(`eval/golden/sources/${name}.jsonl`)) {
        if (g.operation === "delete") continue;
        expect(lookupSynthetic(g.title as string, g.content as string)).toBeDefined();
      }
    }
    expect(lookupSynthetic(material.title, material.body)).toEqual({ malicious: false });
  });
});

describe("lookupSynthetic", () => {
  it("flags malicious variants and only them", () => {
    expect(lookupSynthetic(malicious.title, malicious.body)).toEqual({ malicious: true });
    expect(lookupSynthetic(plain.title, plain.body)).toEqual({ malicious: false });
  });

  it("binds title and body: a listed body under another title is not synthetic", () => {
    expect(lookupSynthetic(`${plain.title} (copy)`, plain.body)).toBeUndefined();
    expect(lookupSynthetic(plain.title, `${plain.body} `)).toBeUndefined();
    expect(lookupSynthetic(plain.body, plain.title)).toBeUndefined();
  });

  it("hashes title and body unambiguously", () => {
    expect(syntheticHash("ab", "c")).not.toBe(syntheticHash("a", "bc"));
  });

  it("returns frozen results, so a caller cannot rewrite an entry", () => {
    const hit = lookupSynthetic(malicious.title, malicious.body);
    expect(Object.isFrozen(hit)).toBe(true);
  });
});

describe("read-only at runtime", () => {
  it("exposes only the lookup and the hash, nothing that adds entries", () => {
    expect(Object.keys(manifest).sort()).toEqual(["lookupSynthetic", "syntheticHash"]);
  });

  it("reads no input but the committed manifest: no file system, environment or home", () => {
    const source = readFileSync(resolve(import.meta.dirname, "synthetic-manifest.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./synthetic-manifest.json", "node:crypto"]);
    expect(source).not.toMatch(/process\.|import\(|require\(/);
  });
});
