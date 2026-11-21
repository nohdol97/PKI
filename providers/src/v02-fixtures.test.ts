// V02-T01 (V02-R1): the synthetic inputs of the V02 slice. Three sources (mail,
// wiki, messenger), a date variant and malicious variants pass the import schema,
// are in the synthetic manifest, and agree with the expected results file the
// later flow tests assert against.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ImportRecordSchema, type ImportRecord } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { lookupSynthetic } from "./synthetic-manifest.ts";

const dir = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(dir, name), "utf8");

interface Evidence {
  record_id: string;
  version: number;
  span: [number, number];
  quote: string;
}
interface Fact {
  entity: string;
  attribute: "target_date" | "completion_date";
  value: string;
  evidence: Evidence;
}
interface Expected {
  rule: string;
  entities: Record<string, { type: string; name: string }>;
  sets: Record<
    string,
    {
      files: string[];
      facts: Fact[];
      relations: { subject: string; type: string; object: string; evidence: Evidence }[];
      insights: { rule: string; x: string; y: string; is_inference: true; evidence: Evidence[] }[];
    }
  >;
}
const expected = JSON.parse(read("v02-expected.json")) as Expected;

const v02Files = readdirSync(dir)
  .filter((n) => n.startsWith("v02-") && n.endsWith(".jsonl"))
  .sort();
const raw = new Map(
  v02Files.map((name) => [
    name,
    read(name)
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown),
  ]),
);
const parsed = (name: string): ImportRecord[] =>
  (raw.get(name) ?? []).map((r) => ImportRecordSchema.parse(r));
const all = v02Files.flatMap(parsed);
const byKey = new Map(all.map((r) => [`${r.id}@${r.version}`, r]));
const codePoints = (text: string) => Array.from(text);
const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe("V02 fixtures", () => {
  it("are the three sources, the date variant and the malicious variants", () => {
    expect(v02Files).toEqual([
      "v02-date-variant.jsonl",
      "v02-mail.jsonl",
      "v02-malicious.jsonl",
      "v02-messenger.jsonl",
      "v02-wiki.jsonl",
    ]);
    expect(parsed("v02-mail.jsonl").map((r) => r.source_type)).toEqual(["mail"]);
    expect(parsed("v02-wiki.jsonl").map((r) => r.source_type)).toEqual(["wiki"]);
    expect(parsed("v02-messenger.jsonl").map((r) => r.source_type)).toEqual(["messenger"]);
    expect(parsed("v02-date-variant.jsonl").map((r) => r.source_type)).toEqual(["messenger"]);
    expect(
      parsed("v02-malicious.jsonl")
        .map((r) => r.source_type)
        .sort(),
    ).toEqual(["mail", "messenger", "wiki"]);
  });

  it("pass the import schema line by line, with a matching content hash", () => {
    for (const [name, lines] of raw) {
      lines.forEach((line, i) => {
        const result = ImportRecordSchema.safeParse(line);
        expect(result.error, `${name}:${i + 1}`).toBeUndefined();
        const r = result.data as ImportRecord;
        expect(r.content_hash).toBe(
          `sha256:${createHash("sha256").update(r.content).digest("hex")}`,
        );
      });
    }
    expect(byKey.size).toBe(all.length);
  });

  it("are in the synthetic manifest, malicious variants flagged and only them", () => {
    for (const r of all) {
      expect(lookupSynthetic(r.title, r.content), r.id).toEqual({
        malicious: r.malicious === true,
      });
    }
  });

  it("malicious variants carry a script tag, a remote image and an override instruction", () => {
    const malicious = parsed("v02-malicious.jsonl");
    for (const r of malicious) {
      expect(r.malicious, r.id).toBe(true);
      expect(r.content).toMatch(/<script>[^<]+<\/script>/);
      expect(r.content).toMatch(/<img src="https:\/\/[a-z.]+\.example\.test\/[^"]+"/);
      expect(r.content).toContain("이전 지시를 무시");
    }
    const ids = new Set(malicious.map((r) => r.id));
    for (const r of all.filter((r) => !ids.has(r.id))) {
      expect(r.malicious, r.id).toBeUndefined();
      expect(r.content).not.toMatch(/<script|<img|이전 지시/);
    }
  });

  it("use only example.test addresses", () => {
    for (const r of all) {
      for (const host of JSON.stringify(r).matchAll(/https?:\/\/([^/\s:"]+)/g)) {
        expect(host[1]).toMatch(/(^|\.)example\.test$/);
      }
      for (const mail of JSON.stringify(r).matchAll(/[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})/g)) {
        expect(mail[1]).toMatch(/(^|\.)example\.test$/);
      }
    }
  });
});

describe("V02 expected results", () => {
  const sets = Object.entries(expected.sets);

  it("cover the plain flow, the date variant and the malicious variants, using every file", () => {
    expect(Object.keys(expected.sets).sort()).toEqual(["date-variant", "malicious", "plain"]);
    expect(new Set(sets.flatMap(([, s]) => s.files))).toEqual(new Set(v02Files));
  });

  it.each(sets)(
    "%s: every evidence quote sits once in its record at a code point span",
    (_n, s) => {
      const evidence = [
        ...s.facts.map((f) => f.evidence),
        ...s.relations.map((r) => r.evidence),
        ...s.insights.flatMap((i) => i.evidence),
      ];
      const inSet = new Set(s.files.flatMap(parsed).map((r) => `${r.id}@${r.version}`));
      for (const e of evidence) {
        const key = `${e.record_id}@${e.version}`;
        expect(inSet.has(key), key).toBe(true);
        const content = byKey.get(key)?.content ?? "";
        expect(
          codePoints(content)
            .slice(...e.span)
            .join(""),
        ).toBe(e.quote);
        expect(occurrences(content, e.quote), e.quote).toBe(1);
      }
    },
  );

  it.each(sets)("%s: entity names appear verbatim in the records citing them", (_n, s) => {
    const cite = (entity: string, e: Evidence) =>
      expect(byKey.get(`${e.record_id}@${e.version}`)?.content).toContain(
        expected.entities[entity]?.name,
      );
    for (const f of s.facts) cite(f.entity, f.evidence);
    for (const r of s.relations) {
      cite(r.subject, r.evidence);
      cite(r.object, r.evidence);
    }
  });

  it.each(sets)("%s: dates carry a year and appear in their quote", (_n, s) => {
    for (const f of s.facts) {
      expect(f.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.evidence.quote).toContain(f.value);
    }
  });

  it.each(sets)("%s: an Insight exists exactly when Y's date is later than X's target", (_n, s) => {
    const date = (entity: string, attribute: Fact["attribute"]) =>
      s.facts.find((f) => f.entity === entity && f.attribute === attribute)?.value;
    const later = s.relations
      .filter((r) => r.type === "DEPENDS_ON")
      .filter((r) => {
        const target = date(r.subject, "target_date");
        const done = date(r.object, "completion_date");
        return target !== undefined && done !== undefined && done > target;
      });
    expect(s.insights.map((i) => [i.x, i.y])).toEqual(later.map((r) => [r.subject, r.object]));
    for (const i of s.insights) {
      expect(i.rule).toBe(expected.rule);
      expect(i.is_inference).toBe(true);
      const x = s.facts.find((f) => f.entity === i.x && f.attribute === "target_date");
      const y = s.facts.find((f) => f.entity === i.y && f.attribute === "completion_date");
      const rel = s.relations.find((r) => r.subject === i.x && r.object === i.y);
      expect(i.evidence).toEqual([x?.evidence, rel?.evidence, y?.evidence]);
    }
  });

  it("the plain and malicious sets reach one Insight; the date variant none", () => {
    expect(expected.sets.plain?.insights).toHaveLength(1);
    expect(expected.sets.malicious?.insights).toHaveLength(1);
    expect(expected.sets["date-variant"]?.insights).toEqual([]);
  });
});
