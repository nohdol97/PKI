// JSONL lines of the Sources screen's import (V02-R2): one line is one version of a
// source, in the R05 golden SourceRecord shape (`ImportRecordSchema`). The checking is
// @pki/connector-sdk's (I01-R22), the one every import path shares; this file adds what
// that screen's importer (jsonl-import.ts) needs on top of it: the V02 error reasons, a
// later line that adds nothing dropped before it is stored, and the rounds that keep one
// read naming a source once. A line is checked alone: a malformed one is refused with
// its 1-based number and the others go on. The fixtures' `malicious` marker is for the
// synthetic manifest only and never reaches a Change.
import { parseJsonl as parseJsonlLines } from "@pki/connector-sdk";
import type { ImportLineError, ImportRecord } from "@pki/contracts";

export interface JsonlLine {
  /** 1-based line number in the text. */
  line: number;
  record: ImportRecord;
}

const REASON = {
  "invalid-json": "invalid-json",
  schema: "invalid-record",
  "content-hash-mismatch": "content-hash-mismatch",
} as const;

/**
 * Every line checked alone; blank lines and a leading UTF-8 BOM are skipped. Each
 * line is one version (V02-R2), so every newer revision of a source is kept, in
 * line order. A later line with an equal or lower revision than the source's last
 * kept line is dropped when its content is the same (nothing new) and refused when
 * it differs (the store's rule, sources.ts).
 */
export function parseJsonl(text: string): { lines: JsonlLine[]; errors: ImportLineError[] } {
  const parsed = parseJsonlLines(text);
  const errors: ImportLineError[] = parsed.rejected.map(({ line, code, field }) =>
    field === undefined ? { line, reason: REASON[code] } : { line, reason: REASON[code], field },
  );
  const lines: JsonlLine[] = [];
  const last = new Map<string, ImportRecord>();
  for (const checked of parsed.lines) {
    const { record } = checked;
    const key = sourceKey(record);
    const previous = last.get(key);
    if (previous && record.version <= previous.version) {
      const same = previous.title === record.title && previous.content === record.content;
      if (!same) errors.push({ line: checked.line, reason: "revision-not-newer" });
      continue;
    }
    last.set(key, record);
    lines.push({ line: checked.line, record });
  }
  errors.sort((a, b) => a.line - b.line);
  return { lines, errors };
}

const sourceKey = (r: ImportRecord) => JSON.stringify([r.connector_instance_id, r.external_id]);

/**
 * Splits lines into rounds: round k holds the k-th line of each source, so one
 * Connector read names each source once (the Connector contract) while a source's
 * lines still become versions in line order, one round after another.
 */
export function splitRounds(lines: readonly JsonlLine[]): JsonlLine[][] {
  const rounds: JsonlLine[][] = [];
  const seen = new Map<string, number>();
  for (const line of lines) {
    const key = sourceKey(line.record);
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    (rounds[k] ??= []).push(line);
  }
  return rounds;
}
