// S01-T08 (S01-R2, R3, R17): the synthetic glossary the surface-form and definition tests read. Two
// import records (a plain page and its malicious variant) pass the import schema, are in the
// synthetic manifest, and agree with fixtures/s01-expected.json: every quote sits once in its record
// at a code point span, every form is in its quote, and every definition is its own quote.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ImportRecordSchema, type ImportRecord } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { EXTRACT_DEFINITION_MAX_CODE_POINTS } from "./index.ts";
import { lookupSynthetic } from "./synthetic-manifest.ts";

const dir = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(dir, name), "utf8");

interface Evidence {
  record_id: string;
  version: number;
  span: [number, number];
  quote: string;
}
interface Expected {
  entities: Record<string, { type: string; name: string }>;
  sameForm: string[][];
  sets: Record<
    string,
    {
      files: string[];
      terms: { entity: string; form: string; kind: string; evidence: Evidence }[];
      definitions: { entity: string; value: string; context: string; evidence: Evidence }[];
    }
  >;
}
const expected = JSON.parse(read("s01-expected.json")) as Expected;
const records = read("s01-glossary.jsonl")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => ImportRecordSchema.parse(JSON.parse(line)));
const byId = new Map<string, ImportRecord>(records.map((r) => [r.id, r]));
const codePoints = (text: string) => Array.from(text);
const occurrences = (text: string, part: string) => text.split(part).length - 1;
const sets = Object.entries(expected.sets);

describe("S01 glossary fixtures", () => {
  it("are a plain page and its malicious variant, with a matching content hash", () => {
    expect(records.map((r) => r.id)).toEqual(["wiki-s01-0001", "wiki-s01-m001"]);
    expect(records.map((r) => r.malicious)).toEqual([undefined, true]);
    for (const r of records) {
      expect(r.content_hash).toBe(`sha256:${createHash("sha256").update(r.content).digest("hex")}`);
    }
  });

  it("are in the synthetic manifest, the malicious variant flagged and only it", () => {
    for (const r of records) {
      expect(lookupSynthetic(r.title, r.content), r.id).toEqual({
        malicious: r.malicious === true,
      });
    }
  });

  it("carry the markup and the override sentence only in the malicious variant, and use example.test addresses", () => {
    const [plain, malicious] = records as [ImportRecord, ImportRecord];
    expect(plain.content).not.toMatch(/<script|<img|이전 지시/);
    expect(malicious.content).toMatch(/<script>[^<]+<\/script>/);
    expect(malicious.content).toMatch(/<img src="https:\/\/[a-z.]+\.example\.test\/[^"]+"/);
    expect(malicious.content).toContain("이전 지시를 무시");
    for (const r of records) {
      for (const host of JSON.stringify(r).matchAll(/https?:\/\/([^/\s:"]+)/g)) {
        expect(host[1]).toMatch(/(^|\.)example\.test$/);
      }
    }
  });
});

describe("S01 expected results", () => {
  it("cover the plain page and the malicious variant", () => {
    expect(Object.keys(expected.sets)).toEqual(["plain", "malicious"]);
    expect(expected.entities.C).toEqual({ type: "Concept", name: "미리내 용어" });
  });

  it.each(sets)(
    "%s: every evidence quote sits once in its record at a code point span",
    (_n, s) => {
      for (const e of [...s.terms, ...s.definitions].map((x) => x.evidence)) {
        const content = byId.get(e.record_id)?.content ?? "";
        expect(
          codePoints(content)
            .slice(...e.span)
            .join(""),
        ).toBe(e.quote);
        expect(occurrences(content, e.quote), e.quote).toBe(1);
      }
    },
  );

  it.each(sets)(
    "%s: a form is in its quote, a definition is its quote and short enough",
    (_n, s) => {
      for (const t of s.terms) expect(t.evidence.quote).toContain(t.form);
      for (const d of s.definitions) {
        expect(d.value).toBe(d.evidence.quote);
        expect(codePoints(d.value).length).toBeLessThanOrEqual(EXTRACT_DEFINITION_MAX_CODE_POINTS);
      }
    },
  );

  it.each(sets)(
    "%s: has the three kinds of form, a pair of the same form, and two contexts",
    (_n, s) => {
      expect(new Set(s.terms.map((t) => t.kind))).toEqual(
        new Set(["synonym", "abbreviation", "translation"]),
      );
      for (const pair of expected.sameForm) {
        const forms = s.terms.map((t) => t.form);
        for (const form of pair) expect(forms).toContain(form);
        expect(new Set(pair.map((f) => f.normalize("NFKC").toLowerCase())).size).toBe(1);
      }
      expect(new Set(s.definitions.map((d) => d.context)).size).toBe(2);
    },
  );
});
