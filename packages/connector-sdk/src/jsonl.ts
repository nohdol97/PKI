// JSONL format v1 (I01-R22): one line is one version of one source, in the shape of
// `ImportRecordSchema`. The file collector (backend/src/adapters/jsonl-connector.ts) and
// the local import API (POST /api/imports) both read a text through `parseJsonl` and
// both hand the changes to the management module's one page store, so a line means the
// same thing on either path. A line is checked alone: a malformed one is refused with
// its 1-based number and a code of the closed list, never with its text, and the others
// go on. The text is untrusted: a line over MAX_JSONL_LINE_CHARS is refused unparsed and
// only a field name of the schema is ever named.
import {
  CONNECTOR_SDK_VERSION,
  ImportRecordSchema,
  type Change,
  type ConnectorCapabilities,
  type ImportRecord,
  type RejectCode,
} from "@pki/contracts";
import { createHash } from "node:crypto";

/** The kind of the Connector that reads a JSONL file; an import API instance has it too. */
export const JSONL_IMPORT_KIND = "jsonl-import";

/**
 * What the JSONL Connector declares (I01-R23): `deletionsOnRescan` is false, because a line
 * removed from a file is no deletion (a deletion is a `delete` line); the rescan of an edited
 * file therefore raises `deletionsMayBeMissed`. The import API judges its page by the same
 * declaration, so a line is accepted or refused alike on both paths.
 */
export const JSONL_CAPABILITIES: ConnectorCapabilities = {
  incremental: true,
  deletes: true,
  accessScope: true,
  fullRescan: true,
  deletionsOnRescan: false,
};

/** Provisional (I01-R24): the most a file or a request body may hold. */
export const MAX_JSONL_BYTES = 10 * 1024 * 1024;

/** Provisional: the deepest nesting a line may have; storage's JSON checks and `stableJson` recurse. */
export const MAX_JSONL_DEPTH = 64;

/** Provisional: the longest line parsed, in UTF-16 units; a longer one is refused as `schema`. */
export const MAX_JSONL_LINE_CHARS = 1024 * 1024;

/** The operation a line names and the kind of change it stands for (I01-R22). */
export function changeKindOf(operation: ImportRecord["operation"]): Change["kind"] {
  switch (operation) {
    case "upsert":
      return "upsert";
    case "delete":
      return "delete";
    // the golden data's definition: the content stays and the scope narrows
    case "revoke":
      return "scope-change";
    case "access-revoked":
      return "access-revoked";
  }
}

/**
 * What a change made from a line remembers of it beside the Change shape, which has no
 * room for it: the place it came from and, for a `revoke`, the content it saw. Keyed by
 * the change object, so it holds only while the object is handed on as it is (in-process,
 * as the file collector and the API do): a change without a note is simply an ordinary one.
 */
interface Note {
  place?: string;
  content?: { title: string; body: string };
}
const notes = new WeakMap<object, Note>();
const noteFor = (change: object): Note => {
  let note = notes.get(change);
  if (!note) notes.set(change, (note = {}));
  return note;
};

/**
 * The title and body a JSONL `revoke` line carried, or undefined for any other change.
 * A scope change has no content of its own; the management module refuses it with
 * `scope-change-content-mismatch` when the stored latest version differs (I01-R22).
 */
export function expectedContent(change: object): { title: string; body: string } | undefined {
  return notes.get(change)?.content;
}

/** `line:<n>`, where a parsed line's change came from, for a refusal's position (I01-R19). */
export function placeOf(change: object): string | undefined {
  return notes.get(change)?.place;
}

export interface ParseOptions {
  /** Where a line's source is unique; default its `connector_instance_id` (I01-R22). */
  namespace?: (record: ImportRecord) => string;
}

/** The change a parsed line stands for. The line's `version` is the revision (I01-R9). */
export function recordToChange(
  record: ImportRecord,
  namespace: (record: ImportRecord) => string = (r) => r.connector_instance_id,
): Change {
  const identity = {
    namespace: namespace(record),
    externalId: record.external_id,
    revision: record.version,
  };
  switch (changeKindOf(record.operation)) {
    case "upsert":
      return {
        kind: "upsert",
        record: {
          ...identity,
          schemaVersion: CONNECTOR_SDK_VERSION,
          title: record.title,
          body: record.content,
          accessScope: record.access_scope,
          sourceType: record.source_type,
          sourceUrl: record.source_url,
          author: record.author,
          participants: record.participants,
          threadId: record.thread_id,
          createdAt: record.created_at,
          updatedAt: record.updated_at,
          metadata: record.metadata,
          attachments: record.attachments?.map((a) => ({
            name: a.name,
            mediaType: a.media_type,
            size: a.size,
          })),
        },
      };
    case "scope-change": {
      const change: Change = {
        kind: "scope-change",
        ...identity,
        at: record.updated_at,
        accessScope: record.access_scope,
      };
      noteFor(change).content = { title: record.title, body: record.content };
      return change;
    }
    case "delete":
      return { kind: "delete", ...identity, at: record.updated_at };
    case "access-revoked":
      return { kind: "access-revoked", ...identity, at: record.updated_at };
  }
}

export interface JsonlLine {
  /** 1-based line number in the text. */
  line: number;
  record: ImportRecord;
  change: Change;
}

/** `field` names a known field of the schema, never text from the file. */
export interface JsonlRejection {
  line: number;
  code: Extract<RejectCode, "invalid-json" | "schema" | "content-hash-mismatch">;
  field?: string;
}

const FIELDS: ReadonlySet<string> = new Set(Object.keys(ImportRecordSchema.shape));
const sha256 = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

/** Only these lines hand a scope on, so only they need one (`accessScope` is non-empty). */
const carriesScope = (operation: ImportRecord["operation"]) =>
  operation === "upsert" || operation === "revoke";

/** Whether `value` nests deeper than `limit`; it stops at the limit, so it never recurses deeper. */
function deeperThan(value: unknown, limit: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (limit <= 0) return true;
  return Object.values(value).some((child) => deeperThan(child, limit - 1));
}

function checkLine(
  text: string,
  line: number,
  namespace: ParseOptions["namespace"],
): JsonlLine | JsonlRejection {
  if (text.length > MAX_JSONL_LINE_CHARS) return { line, code: "schema" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { line, code: "invalid-json" };
  }
  if (deeperThan(value, MAX_JSONL_DEPTH)) return { line, code: "schema" };
  const parsed = ImportRecordSchema.safeParse(value);
  if (!parsed.success) {
    // Only a field of the schema is named: an unknown key is text from the file.
    const field = parsed.error.issues[0]?.path[0];
    return typeof field === "string" && FIELDS.has(field)
      ? { line, code: "schema", field }
      : { line, code: "schema" };
  }
  const record = parsed.data;
  // the scope of the change: non-empty, no empty entry (ChangeSchema's own rule, named here by line)
  if (
    carriesScope(record.operation) &&
    (record.access_scope.length === 0 || record.access_scope.includes(""))
  ) {
    return { line, code: "schema", field: "access_scope" };
  }
  if (record.content_hash !== sha256(record.content)) {
    return { line, code: "content-hash-mismatch" };
  }
  return { line, record, change: recordToChange(record, namespace) };
}

/**
 * Every line checked alone, in line order. Blank lines and a leading UTF-8 BOM are
 * skipped; a line may end in CRLF. Each line is one version, so a source may appear
 * in many lines: the store judges their order (I01-R10).
 */
export function parseJsonl(
  text: string,
  options: ParseOptions = {},
): { lines: JsonlLine[]; rejected: JsonlRejection[] } {
  const lines: JsonlLine[] = [];
  const rejected: JsonlRejection[] = [];
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  body.split("\n").forEach((raw, index) => {
    const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!content.trim()) return;
    const checked = checkLine(content, index + 1, options.namespace);
    if ("change" in checked) {
      noteFor(checked.change).place = `line:${checked.line}`;
      lines.push(checked);
    } else rejected.push(checked);
  });
  return { lines, rejected };
}
