// S02-T02 (S02-R4, R5): the synthetic organisation page the identifier, relation, statement and type
// proposal tests read. Two import records (a plain page and its malicious variant) pass the import schema,
// are in the synthetic manifest, and agree with fixtures/s02-expected.json: every quote sits once in its
// record at a code point span, an identifier is in its quote, and a statement is its own quote.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ImportRecordSchema, type ImportRecord } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import {
  EXTRACT_DEFINITION_MAX_CODE_POINTS,
  EXTRACT_ITEM_TYPES,
  EXTRACT_RELATION_TYPES,
} from "./index.ts";
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
  sets: Record<
    string,
    {
      files: string[];
      facts: {
        entity: string;
        attribute: string;
        value: string;
        context?: string;
        evidence: Evidence;
      }[];
      relations: { subject: string; type: string; object: string; evidence: Evidence }[];
      statements: { entity: string; value: string; context: string; evidence: Evidence }[];
      proposedTypes: { kind: string; name: string; evidence: Evidence }[];
    }
  >;
}
const expected = JSON.parse(read("s02-expected.json")) as Expected;
const records = read("s02-entities.jsonl")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => ImportRecordSchema.parse(JSON.parse(line)));
const byId = new Map<string, ImportRecord>(records.map((r) => [r.id, r]));
const codePoints = (text: string) => Array.from(text);
const occurrences = (text: string, part: string) => text.split(part).length - 1;
const sets = Object.entries(expected.sets);

describe("S02 entity fixtures", () => {
  it("are a plain page and its malicious variant, with a matching content hash", () => {
    expect(records.map((r) => r.id)).toEqual(["wiki-s02-0001", "wiki-s02-m001"]);
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
      for (const mail of r.content.matchAll(/[\w.]+@([\w.]+)/g)) {
        expect(mail[1]).toMatch(/(^|\.)example\.test$/);
      }
    }
  });
});

describe("S02 expected results", () => {
  it("cover the plain page and the malicious variant, with item types and relation types the schema lists", () => {
    expect(Object.keys(expected.sets)).toEqual(["plain", "malicious"]);
    for (const e of Object.values(expected.entities)) {
      expect(EXTRACT_ITEM_TYPES as readonly string[]).toContain(e.type);
    }
    for (const [, s] of sets) {
      for (const r of s.relations) {
        expect(EXTRACT_RELATION_TYPES as readonly string[]).toContain(r.type);
      }
    }
  });

  it.each(sets)(
    "%s: every evidence quote sits once in its record at a code point span",
    (_n, s) => {
      const all = [...s.facts, ...s.relations, ...s.statements, ...s.proposedTypes];
      expect(all.length).toBeGreaterThan(0);
      for (const e of all.map((x) => x.evidence)) {
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
    "%s: an identifier is in its quote, a statement is its quote and short enough, and there are both identifier kinds, a context tag, three relations and a proposal",
    (_n, s) => {
      for (const f of s.facts) expect(f.evidence.quote).toContain(f.value);
      expect(s.facts.map((f) => f.attribute).sort()).toEqual([
        "identifier.email",
        "identifier.key",
      ]);
      expect(s.facts.find((f) => f.attribute === "identifier.key")?.context).toBe("인사");
      for (const d of s.statements) {
        expect(d.value).toBe(d.evidence.quote);
        expect(codePoints(d.value).length).toBeLessThanOrEqual(EXTRACT_DEFINITION_MAX_CODE_POINTS);
        expect(expected.entities[d.entity]?.type).toBe("Decision");
      }
      expect(new Set(s.relations.map((r) => r.type))).toEqual(
        new Set(["BELONGS_TO", "RESPONSIBLE_FOR", "DEPENDS_ON"]),
      );
      expect(s.proposedTypes.map((p) => p.name)).toEqual(["Milestone"]);
      // the proposed name is no type the schema lists
      expect(EXTRACT_ITEM_TYPES as readonly string[]).not.toContain("Milestone");
    },
  );
});
