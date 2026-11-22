// I01-R22 `import.*`: the JSONL line parser every import path shares. Synthetic data only.
import { ChangeSchema, type ImportRecord } from "@pki/contracts";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  changeKindOf,
  expectedContent,
  JSONL_IMPORT_KIND,
  MAX_JSONL_BYTES,
  MAX_JSONL_LINE_CHARS,
  parseJsonl,
  recordToChange,
} from "./index.ts";

const hashOf = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

const BASE: ImportRecord = {
  id: "mail-0001",
  source_type: "mail",
  external_id: "ext-1",
  title: "Synthetic title",
  content: "Synthetic body",
  author: "a@example.test",
  participants: ["b@example.test"],
  thread_id: "thread-1",
  source_url: "https://mail.example.test/1",
  created_at: "2026-11-01T09:00:00+09:00",
  updated_at: "2026-11-02T09:00:00+09:00",
  content_hash: hashOf("Synthetic body"),
  version: 3,
  access_scope: ["user:a", "group:x"],
  metadata: { label: "one" },
  connector_instance_id: "conn-mail-01",
  operation: "upsert",
  schema_version: "1",
};
/** One line with fields replaced; the hash follows a replaced content unless it is given. */
const line = (patch: Record<string, unknown> = {}) => {
  const record: Record<string, unknown> = { ...BASE, ...patch };
  if ("content" in patch && !("content_hash" in patch)) {
    record.content_hash = hashOf(record.content as string);
  }
  return JSON.stringify(record);
};

describe("import.revoke-switch: the operation to change kind function (V02-T04's, switched)", () => {
  it("maps revoke to scope-change and access-revoked to access-revoked", () => {
    expect(changeKindOf("upsert")).toBe("upsert");
    expect(changeKindOf("delete")).toBe("delete");
    expect(changeKindOf("revoke")).toBe("scope-change");
    expect(changeKindOf("access-revoked")).toBe("access-revoked");
  });
});

describe("import.schema-errors: a line is refused alone, by place and code", () => {
  it("names each refused line by its number and a closed code, and keeps the others", () => {
    const text = [
      line({ external_id: "ok-1" }),
      "{not json",
      JSON.stringify({ ...BASE, external_id: undefined }),
      line({ external_id: "empty", access_scope: [] }),
      line({ external_id: "bad-hash", content_hash: hashOf("something else") }),
      line({ external_id: "ok-2" }),
    ].join("\n");
    const { lines, rejected } = parseJsonl(text);
    expect(lines.map((l) => l.line)).toEqual([1, 6]);
    expect(rejected).toEqual([
      { line: 2, code: "invalid-json" },
      { line: 3, code: "schema", field: "external_id" },
      { line: 4, code: "schema", field: "access_scope" },
      { line: 5, code: "content-hash-mismatch" },
    ]);
  });

  it("does not echo a line's text: a canary in a value, in an unknown key and in broken JSON", () => {
    const canary = "CANARY-line-text-4410";
    const text = [
      line({ title: 7, [canary]: canary }),
      `{"${canary}": `,
      line({ content_hash: hashOf(canary), content: "x" }),
      line({ access_scope: [], title: canary }),
    ].join("\n");
    const { rejected } = parseJsonl(text);
    expect(rejected).toHaveLength(4);
    expect(JSON.stringify(rejected)).not.toContain(canary);
    // an unknown key is text from the file: it is never named as a field
    expect(rejected[0]).toEqual({ line: 1, code: "schema", field: "title" });
  });

  it("applies the empty-scope rule only to lines whose change carries a scope", () => {
    const text = [
      line({ external_id: "d", operation: "delete", content: "", access_scope: [] }),
      line({ external_id: "a", operation: "access-revoked", access_scope: [] }),
      line({ external_id: "r", operation: "revoke", access_scope: [] }),
      line({ external_id: "u", operation: "upsert", access_scope: [] }),
    ].join("\n");
    const { lines, rejected } = parseJsonl(text);
    expect(lines.map((l) => l.line)).toEqual([1, 2]);
    expect(rejected).toEqual([
      { line: 3, code: "schema", field: "access_scope" },
      { line: 4, code: "schema", field: "access_scope" },
    ]);
  });

  it("skips blank lines and a leading BOM and numbers lines from 1 of the text, CRLF included", () => {
    const text = `\uFEFF${line({ external_id: "a" })}\r\n\r\n${line({ external_id: "b" })}\r\n`;
    expect(parseJsonl(text).lines.map((l) => l.line)).toEqual([1, 3]);
  });

  it("refuses a line over the per-line limit before parsing it, and reads the next", () => {
    const huge = line({ content: "x".repeat(MAX_JSONL_LINE_CHARS) });
    const { lines, rejected } = parseJsonl([huge, line({ external_id: "after" })].join("\n"));
    expect(rejected).toEqual([{ line: 1, code: "schema" }]);
    expect(lines.map((l) => l.line)).toEqual([2]);
  });

  it("states a text limit of 10 MiB that the API and the file collector share", () => {
    expect(MAX_JSONL_BYTES).toBe(10 * 1024 * 1024);
    expect(JSONL_IMPORT_KIND).toBe("jsonl-import");
  });

  it("is not polluted by a __proto__ or constructor key in the file", () => {
    const text = [
      `{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}`,
      line().replace(
        `"metadata":{"label":"one"}`,
        `"metadata":{"__proto__":{"polluted":"yes"},"a":1}`,
      ),
    ].join("\n");
    const { lines, rejected } = parseJsonl(text);
    expect(rejected).toEqual([{ line: 1, code: "schema", field: "id" }]);
    expect(lines.map((l) => l.line)).toEqual([2]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    const change = lines[0]?.change;
    const metadata = change?.kind === "upsert" ? (change.record.metadata ?? {}) : {};
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    expect(Object.hasOwn(metadata, "polluted")).toBe(false);
  });
});

describe("import.identity: a line becomes the change of I01-R22's table", () => {
  it("carries the line's version as the revision and the source facts under camelCase names", () => {
    const { lines } = parseJsonl(line());
    expect(lines[0]?.change).toEqual({
      kind: "upsert",
      record: {
        namespace: "conn-mail-01",
        externalId: "ext-1",
        revision: 3,
        schemaVersion: 2,
        title: "Synthetic title",
        body: "Synthetic body",
        accessScope: ["user:a", "group:x"],
        sourceType: "mail",
        sourceUrl: "https://mail.example.test/1",
        author: "a@example.test",
        participants: ["b@example.test"],
        threadId: "thread-1",
        createdAt: "2026-11-01T09:00:00+09:00",
        updatedAt: "2026-11-02T09:00:00+09:00",
        metadata: { label: "one" },
      },
    });
    expect(ChangeSchema.safeParse(lines[0]?.change).success).toBe(true);
  });

  it("never carries the id, the hash or the malicious marker", () => {
    const { lines } = parseJsonl(line({ malicious: true }));
    const change = lines[0]?.change;
    expect(JSON.stringify(change)).not.toMatch(/mail-0001|sha256|malicious/);
  });

  it("takes the namespace a caller names (the V02 importer's one-instance-per-id structure)", () => {
    const { lines } = parseJsonl(line(), { namespace: () => "" });
    expect(lines[0]?.change.kind === "upsert" && lines[0].change.record.namespace).toBe("");
  });

  it.each([
    ["delete", { operation: "delete", content: "" }, "delete"],
    ["access-revoked", { operation: "access-revoked" }, "access-revoked"],
  ] as const)("hands a %s line on with its revision and time, no content", (_n, patch, kind) => {
    const { lines } = parseJsonl(line(patch));
    expect(lines[0]?.change).toEqual({
      kind,
      namespace: "conn-mail-01",
      externalId: "ext-1",
      revision: 3,
      at: "2026-11-02T09:00:00+09:00",
    });
  });

  it("hands a revoke line on as a scope change that remembers the content it saw", () => {
    const { lines } = parseJsonl(line({ operation: "revoke", access_scope: ["user:a"] }));
    const change = lines[0]?.change;
    expect(change).toEqual({
      kind: "scope-change",
      namespace: "conn-mail-01",
      externalId: "ext-1",
      revision: 3,
      at: "2026-11-02T09:00:00+09:00",
      accessScope: ["user:a"],
    });
    expect(expectedContent(change as object)).toEqual({
      title: "Synthetic title",
      body: "Synthetic body",
    });
    // only a scope change from a JSONL line has one
    expect(expectedContent(parseJsonl(line()).lines[0]?.change as object)).toBeUndefined();
  });

  it("recordToChange is the one mapping the parser and the file collector's records use", () => {
    expect(recordToChange(BASE)).toEqual(parseJsonl(line()).lines[0]?.change);
  });
});
