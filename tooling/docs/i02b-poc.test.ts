// I02B-C46 `docs.poc-record`: the research document of the I02B-T01 measurements has one
// section per row of the I02B-R50 table, and each section carries the command that was run,
// the observed output and a verdict that is one of the three words. A verdict `실패` also
// names the place in the spec that changes. This test does not judge whether a verdict is right
// (that is the review's job); it keeps a row from going missing or a verdict from becoming a
// fourth word.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsDir = resolve(import.meta.dirname, "../../docs");
const specText = readFileSync(
  resolve(docsDir, "specs/2026-11-22-I02-local-file-import.md"),
  "utf8",
);
const recordText = readFileSync(resolve(docsDir, "research/2026-11-22-I02B-T01-poc.md"), "utf8");

const VERDICTS = ["통과", "실패", "판정 불가"];

/** The rows of the I02B-R50 table, in order (the first cell of each). */
function r50Rows(spec: string): string[] {
  const start = spec.indexOf("- **I02B-R50 ");
  if (start < 0) return [];
  const rest = spec.slice(start).split("\n").slice(1);
  const rows: string[] = [];
  let inTable = false;
  for (const line of rest) {
    if (/^\s+\|/.test(line)) {
      inTable = true;
      rows.push(line.trim());
    } else if (inTable) break;
  }
  // header and separator
  return rows.slice(2).map((r) => (r.split("|")[1] ?? "").trim());
}

/** `### 항목 N` sections of the record, by number. */
function sections(record: string): Map<number, string> {
  const out = new Map<number, string>();
  const parts = record.split(/^(?=### 항목 )/m);
  for (const part of parts) {
    const head = /^### 항목 (\d+)/.exec(part);
    if (head) out.set(Number(head[1]), part.split(/^## /m)[0] ?? part);
  }
  return out;
}

describe("docs.poc-record: the I02B-T01 record covers every I02B-R50 row", () => {
  const rows = r50Rows(specText);
  const found = sections(recordText);

  it("the spec's R50 table has the seven rows this record is checked against", () => {
    expect(rows).toHaveLength(7);
  });

  it("the record has one section per row, numbered 1 to the row count", () => {
    expect([...found.keys()]).toEqual(rows.map((_, i) => i + 1));
  });

  for (let n = 1; n <= 7; n++) {
    it(`item ${n}: command, observed output, a verdict from the three words`, () => {
      const section = found.get(n) ?? "";
      expect(section, `section ${n}`).not.toBe("");
      expect(section, "돌린 명령").toMatch(/\*\*돌린 명령\*\*/);
      expect(section, "관찰한 출력").toMatch(/\*\*관찰한 출력\*\*/);
      // a fenced block follows each of the two labels (a label alone is not evidence)
      expect(section.split("```").length - 1, "fenced blocks").toBeGreaterThanOrEqual(4);
      const verdicts = [...section.matchAll(/\*\*판정[^*\n]*\*\*:\s*`([^`]*)`/g)].map((m) => m[1]);
      expect(verdicts.length, "판정").toBeGreaterThanOrEqual(1);
      for (const v of verdicts) expect(VERDICTS, `verdict "${v}"`).toContain(v);
      if (verdicts.includes("실패")) {
        expect(section, "실패에는 바뀌는 자리").toMatch(/\*\*바뀌는 자리\*\*/);
      }
    });
  }

  it("a verdict resting on reading code alone is not allowed to stay a pass", () => {
    // the review turns such a verdict into 판정 불가 (I02B-C46); the record must not say it as its basis
    expect(recordText).not.toMatch(/코드를 읽어 보니/);
  });
});
