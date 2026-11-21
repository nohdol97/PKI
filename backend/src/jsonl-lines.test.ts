// V02-R2: a JSONL line is checked alone; a malformed one is refused with its
// 1-based line number; of one source's lines the newest revision is kept; and
// `operation` becomes the Connector's change kind through one function.
import { ImportRecordSchema, type ImportRecord } from "@pki/contracts";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { changeKindOf, parseJsonl, splitRounds } from "./jsonl-lines.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
const ALL = readdirSync(FIXTURES)
  .filter((f) => /^v02-.*\.jsonl$/.test(f))
  .map(fixture)
  .join("\n");

const GOLDEN_DIR = resolve(import.meta.dirname, "../../eval/golden/sources");
const GOLDEN = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".jsonl"));

const MAIL = JSON.parse(fixture("v02-mail.jsonl").trim()) as ImportRecord;
const hashOf = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
/** The mail fixture with fields replaced; the content hash follows the content. */
const line = (patch: Partial<ImportRecord> & Record<string, unknown> = {}) => {
  const record = { ...MAIL, ...patch };
  return JSON.stringify(
    "content" in patch && !("content_hash" in patch)
      ? { ...record, content_hash: hashOf(record.content) }
      : record,
  );
};

describe("parseJsonl", () => {
  it("accepts every V02 fixture line", () => {
    const { lines, errors } = parseJsonl(ALL);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(ALL.split("\n").filter((l) => l.trim()).length);
  });

  it("refuses only the malformed lines and names each by its 1-based line number", () => {
    const text = [
      line(),
      "{not json",
      "",
      line({ external_id: "x2", created_at: "2026-11-03" }),
      line({ external_id: "x3", operation: "move" as never }),
      line({ external_id: "x4", extra: 1 }),
      line({ external_id: "x5" }),
    ].join("\r\n");
    const { lines, errors } = parseJsonl(text);
    expect(lines.map((l) => [l.line, l.record.external_id])).toEqual([
      [1, MAIL.external_id],
      [7, "x5"],
    ]);
    expect(errors).toEqual([
      { line: 2, reason: "invalid-json" },
      { line: 4, reason: "invalid-record", field: "created_at" },
      { line: 5, reason: "invalid-record", field: "operation" },
      // an unknown key is not echoed back: it is text from the imported file
      { line: 6, reason: "invalid-record" },
    ]);
  });

  it("refuses a line whose content_hash is not the sha256 of its content", () => {
    const { lines, errors } = parseJsonl(
      line({ content: "다른 본문", content_hash: MAIL.content_hash }),
    );
    expect(lines).toEqual([]);
    expect(errors).toEqual([{ line: 1, reason: "content-hash-mismatch" }]);
  });

  it("keeps every newer revision of a source as its own line, in line order (R2: one line, one version)", () => {
    const text = [
      line({ content: "v1" }),
      line({ version: 2, content: "v2" }),
      line({ version: 2, content: "v2" }),
      line({ version: 1, content: "v1 again" }),
      line({ connector_instance_id: "conn-other", content: "v1" }),
    ].join("\n");
    const { lines, errors } = parseJsonl(text);
    expect(lines.map((l) => [l.line, l.record.version, l.record.connector_instance_id])).toEqual([
      [1, 1, MAIL.connector_instance_id],
      [2, 2, MAIL.connector_instance_id],
      [5, 1, "conn-other"],
    ]);
    // line 3 repeats line 2 exactly: nothing new, nothing wrong
    expect(errors).toEqual([{ line: 4, reason: "revision-not-newer" }]);
  });

  it("strips a leading UTF-8 BOM (a file posted straight to the API)", () => {
    const { lines, errors } = parseJsonl(`\uFEFF${line()}`);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it.each(GOLDEN)("drops no line of golden %s without a reason", (name) => {
    const text = readFileSync(resolve(GOLDEN_DIR, name), "utf8");
    const { lines, errors } = parseJsonl(text);
    expect(errors).toEqual([]);
    expect(lines.map((l) => l.line)).toEqual(
      text.split("\n").flatMap((l, i) => (l.trim() ? [i + 1] : [])),
    );
  });
});

describe("splitRounds", () => {
  it("puts each source's k-th line in round k, so a round names each source once", () => {
    const text = [
      line({ external_id: "a", content: "a1" }),
      line({ external_id: "b", content: "b1" }),
      line({ external_id: "a", version: 2, content: "a2" }),
      line({ external_id: "a", version: 3, content: "a3" }),
      line({ external_id: "b", version: 2, content: "b2" }),
    ].join("\n");
    expect(splitRounds(parseJsonl(text).lines).map((r) => r.map((l) => l.line))).toEqual([
      [1, 2],
      [3, 5],
      [4],
    ]);
  });
});

describe("operation mapping (V02-R2)", () => {
  it("maps upsert and delete to the change kinds of the same name", () => {
    expect(changeKindOf("upsert")).toBe("upsert");
    expect(changeKindOf("delete")).toBe("delete");
  });

  // Provisional pending I01: I01 maps revoke to a scope change and adds an
  // explicit operation for losing access entirely (V02 spec "T04가 넘기는 것").
  it("maps revoke to access-revoked (provisional, pending I01)", () => {
    expect(changeKindOf("revoke")).toBe("access-revoked");
  });

  it("covers every operation the line schema accepts", () => {
    for (const op of ImportRecordSchema.shape.operation.options) {
      expect(["upsert", "delete", "access-revoked"]).toContain(changeKindOf(op));
    }
  });
});
