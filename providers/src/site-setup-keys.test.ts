// V01-R19 (spec "T17이 넘기는 것" 4): the runtime settings table of docs/site-setup.md
// names exactly the setting keys the product reads, the `*_SETTING` constants this
// package's entry exports. A key the table names but nothing reads, or a key the
// code reads that the table leaves out, fails here. A setting a package other than this
// one reads (this package may not import it) is listed in OTHER_PACKAGE_KEYS with the
// file whose `*_SETTING` constant holds it (I03-T13: `jobs.maxConcurrent`).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

const SITE_SETUP = resolve(import.meta.dirname, "../../docs/site-setup.md");
const HEADING = "### 실행 중 설정";

/** The backticked keys opening the rows of the runtime settings table. */
function runtimeKeys(text: string): string[] | undefined {
  const lines = text.split("\n");
  const start = lines.indexOf(HEADING);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("#"));
  return (end < 0 ? rest : rest.slice(0, end)).flatMap(
    (l) => /^\| `([^`]+)` \|/.exec(l)?.[1] ?? [],
  );
}

const OTHER_PACKAGE_KEYS = [
  {
    key: "jobs.maxConcurrent",
    file: "../../backend/src/job-runner.ts",
    holds: 'JOBS_MAX_CONCURRENT_SETTING = "jobs.maxConcurrent"',
  },
] as const;

const implemented = Object.entries(entry)
  .filter(([name, value]) => name.endsWith("_SETTING") && typeof value === "string")
  .map(([, value]) => value as string)
  .sort();

describe("site-setup runtime setting keys (V01-R19)", () => {
  const text = readFileSync(SITE_SETUP, "utf8");

  it("the entry exports the settings the product reads", () => {
    expect(implemented).toEqual([
      "providers.cli.background",
      "providers.default",
      "providers.openaiCompatible.baseUrl",
      "providers.openaiCompatible.model",
    ]);
  });

  it("the other packages' settings the table names are held by the code that reads them", () => {
    for (const other of OTHER_PACKAGE_KEYS) {
      expect(readFileSync(resolve(import.meta.dirname, other.file), "utf8")).toContain(other.holds);
    }
  });

  const documented = [...implemented, ...OTHER_PACKAGE_KEYS.map((o) => o.key)].sort();

  it("the table names exactly those keys, once each", () => {
    const keys = runtimeKeys(text);
    expect(keys).toBeDefined();
    expect([...(keys ?? [])].sort()).toEqual(documented);
  });

  it("fails for a key nothing reads", () => {
    const stale = text.replace(
      "| `providers.default` |",
      "| `providers.enabled` | 목록 | 전부 |\n| `providers.default` |",
    );
    expect([...(runtimeKeys(stale) ?? [])].sort()).not.toEqual(documented);
  });

  it("fails for a key the code reads but the table leaves out", () => {
    const missing = text.replace(/^\| `providers\.cli\.background` \|.*\n/m, "");
    expect([...(runtimeKeys(missing) ?? [])].sort()).not.toEqual(documented);
  });

  it("fails when the other package's key is dropped from the table", () => {
    const dropped = text.replace(/^\| `jobs\.maxConcurrent` \|.*\n/m, "");
    expect([...(runtimeKeys(dropped) ?? [])].sort()).not.toEqual(documented);
  });
});
