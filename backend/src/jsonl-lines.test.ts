// V02-R2: a JSONL line is checked alone; a malformed one is refused with its
// 1-based line number; of one source's lines the newest revision is kept; and
// `operation` becomes the Connector's change kind through one function.
import { ImportRecordSchema, type ImportRecord } from "@pki/contracts";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { changeKindOf, parseJsonl } from "./jsonl-lines.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
const ALL = readdirSync(FIXTURES)
  .filter((f) => /^v02-.*\.jsonl$/.test(f))
  .map(fixture)
  .join("\n");

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

  it("keeps the newest revision of a source in a file and refuses an older one with other content", () => {
    const text = [
      line({ content: "v1" }),
      line({ version: 2, content: "v2" }),
      line({ version: 2, content: "v2" }),
      line({ version: 1, content: "v1 again" }),
      line({ connector_instance_id: "conn-other", content: "v1" }),
    ].join("\n");
    const { lines, errors } = parseJsonl(text);
    expect(lines.map((l) => [l.line, l.record.version, l.record.connector_instance_id])).toEqual([
      [2, 2, MAIL.connector_instance_id],
      [5, 1, "conn-other"],
    ]);
    // line 3 repeats line 2 exactly: nothing new, nothing wrong
    expect(errors).toEqual([{ line: 4, reason: "revision-not-newer" }]);
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
