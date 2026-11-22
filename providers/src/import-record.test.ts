// V02-R1: one JSONL import line has the R05 golden SourceRecord shape. The
// golden sources themselves must pass, so the two cannot drift apart. It lives
// here because reading eval/ needs node types, which @pki/contracts does not load.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ImportRecordSchema, MAX_INSTANCE_ID_LENGTH } from "@pki/contracts";

const sources = resolve(import.meta.dirname, "../../eval/golden/sources");
const golden = ["mail", "wiki", "messenger"].flatMap((name) =>
  readFileSync(resolve(sources, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>),
);
const record = golden.find((r) => r.operation === "upsert") as Record<string, unknown>;

describe("ImportRecordSchema", () => {
  it("accepts every R05 golden source record", () => {
    expect(golden.length).toBeGreaterThan(0);
    for (const r of golden) expect(ImportRecordSchema.safeParse(r).error).toBeUndefined();
  });

  it("accepts the fixture-only malicious marker, and only as true", () => {
    expect(ImportRecordSchema.safeParse({ ...record, malicious: true }).success).toBe(true);
    expect(ImportRecordSchema.safeParse({ ...record, malicious: false }).success).toBe(false);
  });

  it.each(["content", "connector_instance_id", "operation", "schema_version", "content_hash"])(
    "rejects a line without %s",
    (key) => {
      const rest = Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
      expect(ImportRecordSchema.safeParse(rest).success).toBe(false);
    },
  );

  it.each([
    ["an unknown key", { classification: "synthetic" }],
    ["an unknown operation", { operation: "purge" }],
    ["an unknown source type", { source_type: "calendar" }],
    ["version 0", { version: 0 }],
    ["a timestamp without an offset", { created_at: "2026-11-03T10:12:00" }],
    ["a malformed content hash", { content_hash: "da10df74" }],
    ["another schema version", { schema_version: "2" }],
  ])("rejects %s", (_name, change) => {
    expect(ImportRecordSchema.safeParse({ ...record, ...change }).success).toBe(false);
  });

  // import.revoke-switch ①: I01-R22 adds `access-revoked`; the schema and the golden checker
  // (eval/scorer/validate.py) keep one vocabulary
  it("takes access-revoked, and its operations are the golden checker's", () => {
    expect(ImportRecordSchema.safeParse({ ...record, operation: "access-revoked" }).success).toBe(
      true,
    );
    const checker = readFileSync(
      resolve(import.meta.dirname, "../../eval/scorer/validate.py"),
      "utf8",
    );
    const declared = /^OPERATIONS = \{(.*)\}$/m.exec(checker)?.[1] ?? "";
    const names = [...declared.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect([...names].sort()).toEqual([...ImportRecordSchema.shape.operation.options].sort());
  });

  it("caps a connector instance id at the one limit, which the golden checker shares", () => {
    const max = "i".repeat(MAX_INSTANCE_ID_LENGTH);
    expect(ImportRecordSchema.safeParse({ ...record, connector_instance_id: max }).success).toBe(
      true,
    );
    expect(
      ImportRecordSchema.safeParse({ ...record, connector_instance_id: `${max}i` }).success,
    ).toBe(false);
    expect(ImportRecordSchema.safeParse({ ...record, connector_instance_id: "" }).success).toBe(
      false,
    );
    const checker = readFileSync(
      resolve(import.meta.dirname, "../../eval/scorer/validate.py"),
      "utf8",
    );
    expect(Number(/^MAX_INSTANCE_ID_LENGTH = (\d+)$/m.exec(checker)?.[1])).toBe(
      MAX_INSTANCE_ID_LENGTH,
    );
  });

  it("requires a delete line to carry empty content", () => {
    const del = { ...record, operation: "delete", version: 2 };
    expect(ImportRecordSchema.safeParse(del).success).toBe(false);
    expect(ImportRecordSchema.safeParse({ ...del, content: "" }).success).toBe(true);
  });
});
