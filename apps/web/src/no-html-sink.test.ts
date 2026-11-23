// H03-C1 C2: no web source writes markup into the page; every sink API that would turn stored
// text into HTML is absent, so imported content can only reach the screen as text nodes.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SINKS = [
  "dangerouslySetInnerHTML",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "document.write",
  "srcDoc",
];
const SRC = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const hits = (text: string) => SINKS.filter((name) => text.includes(name));

describe("web sources have no HTML sink (H03-C1)", () => {
  it("scans a non-empty set of sources and finds no sink name", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("no-html-sink.test.ts"))).toBe(false);
    const found = files.flatMap((f) => hits(readFileSync(f, "utf8")).map((n) => `${f}: ${n}`));
    expect(found).toEqual([]);
  });

  it("the scanner detects every sink name in a control string", () => {
    for (const name of SINKS) expect(hits(`el.${name} = x`)).toEqual([name]);
  });
});
