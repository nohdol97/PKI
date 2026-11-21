// JSONL lines (V02-R2): one line is one version of a source, in the R05 golden
// SourceRecord shape (`ImportRecordSchema`). A line is checked alone: a malformed
// one is refused with its 1-based number and the others go on. The JSONL
// Connector (adapters/jsonl-connector.ts) and the importer (jsonl-import.ts) both
// read a text through parseJsonl. The fixtures' `malicious` marker is for the
// synthetic manifest only and never reaches a Change.
import {
  ImportRecordSchema,
  type Change,
  type ImportLineError,
  type ImportRecord,
} from "@pki/contracts";
import { createHash } from "node:crypto";

/**
 * The one place a JSONL `operation` becomes a Connector change kind. Provisional
 * for `revoke`: I01 maps it to a scope change and adds an operation for losing
 * access entirely (V02 spec "T04가 넘기는 것").
 */
export function changeKindOf(operation: ImportRecord["operation"]): Change["kind"] {
  switch (operation) {
    case "upsert":
      return "upsert";
    case "delete":
      return "delete";
    case "revoke":
      return "access-revoked";
  }
}

export interface JsonlLine {
  /** 1-based line number in the text. */
  line: number;
  record: ImportRecord;
}

const FIELDS: ReadonlySet<string> = new Set(Object.keys(ImportRecordSchema.shape));
const sha256 = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

function checkLine(text: string, line: number): JsonlLine | ImportLineError {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { line, reason: "invalid-json" };
  }
  const parsed = ImportRecordSchema.safeParse(value);
  if (!parsed.success) {
    // Only a field of the schema is named: an unknown key is text from the file.
    const field = parsed.error.issues[0]?.path[0];
    return typeof field === "string" && FIELDS.has(field)
      ? { line, reason: "invalid-record", field }
      : { line, reason: "invalid-record" };
  }
  if (parsed.data.content_hash !== sha256(parsed.data.content)) {
    return { line, reason: "content-hash-mismatch" };
  }
  return { line, record: parsed.data };
}

/**
 * Every line checked alone; blank lines are skipped. Of the lines naming one
 * source (instance + external id), the last newer revision is kept: a later line
 * repeating a kept revision's content is dropped, one with an equal or lower
 * revision and other content is refused (the store's rule, sources.ts). The kept
 * lines come back in the order of their line numbers.
 */
export function parseJsonl(text: string): { lines: JsonlLine[]; errors: ImportLineError[] } {
  const kept = new Map<string, JsonlLine>();
  const errors: ImportLineError[] = [];
  text.split("\n").forEach((raw, index) => {
    const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!content.trim()) return;
    const checked = checkLine(content, index + 1);
    if (!("record" in checked)) return void errors.push(checked);
    const { record } = checked;
    const key = JSON.stringify([record.connector_instance_id, record.external_id]);
    const previous = kept.get(key)?.record;
    if (previous && record.version <= previous.version) {
      const same = previous.title === record.title && previous.content === record.content;
      if (!same) errors.push({ line: checked.line, reason: "revision-not-newer" });
      return;
    }
    kept.set(key, checked);
  });
  return { lines: [...kept.values()].sort((a, b) => a.line - b.line), errors };
}

/** The Connector change a line stands for; only the fields of SourceRecord are carried. */
export function toChange(record: ImportRecord): Change {
  const kind = changeKindOf(record.operation);
  if (kind === "upsert") {
    return {
      kind,
      record: {
        externalId: record.external_id,
        title: record.title,
        body: record.content,
        revision: record.version,
      },
    };
  }
  return { kind, externalId: record.external_id, version: record.version, at: record.updated_at };
}
