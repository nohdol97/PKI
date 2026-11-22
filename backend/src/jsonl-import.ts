// JSONL import (V02-R2): the Sources screen's import of one JSONL text. The text
// is parsed once (jsonl-lines.ts). Each `connector_instance_id` in it, up to a cap
// per file, is synced as its own instance of the JSONL Connector (kind
// `jsonl-import`) in rounds: round k carries the k-th line of each source, so every
// line becomes a version in line order while one Connector read names each source
// once. Each round reads from the start, so importing the same text again reads
// every line and stores nothing new (C3 reimport). Every line not stored is
// reported by its number; the answer lists the first errors and counts them all.
import type {
  Change,
  Connector,
  ImportJsonlResponse,
  ImportLineError,
  ImportRecord,
} from "@pki/contracts";
import { readConnectorKind, type SqlDriver } from "@pki/storage";
import { syncConnector, type SyncOptions } from "./connectors.ts";
import { parseJsonl, splitRounds, type JsonlLine } from "./jsonl-lines.ts";

export const JSONL_CONNECTOR_KIND = "jsonl-import";
/** Provisional: distinct instances one file may name; each leaves a permanent row. */
export const MAX_IMPORT_INSTANCES = 32;
/** Provisional: refused lines listed in an answer; `errorCount` counts them all. */
export const IMPORT_ERROR_LIMIT = 100;

export type JsonlImporter = (text: string) => Promise<ImportJsonlResponse>;

export interface ImportOptions extends Pick<SyncOptions, "runner" | "projections"> {
  /** The JSONL Connector, chosen by the composition point (composition.ts). */
  createConnector: () => Connector;
  /**
   * Takes an error that failed an instance's sync (its lines are reported
   * `instance-failed`). The error's message may carry file text: log its class only.
   */
  onError?: (error: unknown) => void;
}

const externalIdOf = (change: Change) =>
  change.kind === "upsert" ? change.record.externalId : change.externalId;

/** Syncs one instance's lines round by round; returns the lines never reached. */
async function importInstance(
  db: SqlDriver,
  instanceId: string,
  lines: readonly JsonlLine[],
  options: ImportOptions,
  report: {
    stored(created: boolean): void;
    refused(line: number, reason: ImportLineError["reason"]): void;
  },
): Promise<number[]> {
  const rounds = splitRounds(lines);
  for (const [k, round] of rounds.entries()) {
    const lineOf = new Map(round.map((l) => [l.record.external_id, l.line]));
    const done = new Set<number>();
    try {
      const connector = options.createConnector();
      await connector.initialize({ records: round.map((l): ImportRecord => l.record) });
      await syncConnector(db, instanceId, JSONL_CONNECTOR_KIND, connector, {
        ...(options.runner ? { runner: options.runner } : {}),
        ...(options.projections ? { projections: options.projections } : {}),
        rescan: true,
        onRefused: (change, reason) => {
          const line = lineOf.get(externalIdOf(change)) as number;
          done.add(line);
          report.refused(line, reason);
        },
        onStored: (change, outcome) => {
          done.add(lineOf.get(externalIdOf(change)) as number);
          report.stored(outcome === "created");
        },
      });
    } catch (error) {
      options.onError?.(error);
      // A failed page stored nothing of itself (one transaction); its lines and
      // the later rounds' are reported, the pages committed before it stay.
      const rest = rounds.slice(k + 1).flat();
      return [...round.map((l) => l.line).filter((l) => !done.has(l)), ...rest.map((l) => l.line)];
    }
  }
  return [];
}

export async function importJsonl(
  db: SqlDriver,
  text: string,
  options: ImportOptions,
): Promise<ImportJsonlResponse> {
  const parsed = parseJsonl(text);
  const errors: ImportLineError[] = [...parsed.errors];
  const instances = new Map<string, JsonlLine[]>();
  for (const line of parsed.lines) {
    const id = line.record.connector_instance_id;
    const own = instances.get(id);
    if (own) own.push(line);
    else if (instances.size < MAX_IMPORT_INSTANCES) instances.set(id, [line]);
    else errors.push({ line: line.line, reason: "too-many-instances" });
  }
  let received = 0;
  let created = 0;
  const report = {
    stored(isNew: boolean) {
      received++;
      if (isNew) created++;
    },
    refused(line: number, reason: ImportLineError["reason"]) {
      received++;
      errors.push({ line, reason });
    },
  };
  const boundElsewhere = (id: string) => {
    const kind = readConnectorKind(db, id);
    return kind !== undefined && kind !== JSONL_CONNECTOR_KIND;
  };
  for (const [instanceId, lines] of instances) {
    if (boundElsewhere(instanceId)) {
      for (const { line } of lines) errors.push({ line, reason: "instance-conflict" });
      continue;
    }
    const failed = await importInstance(db, instanceId, lines, options, report);
    // bound to another kind meanwhile (a rebind race), or its sync failed
    const reason = boundElsewhere(instanceId) ? "instance-conflict" : "instance-failed";
    for (const line of failed) errors.push({ line, reason });
  }
  errors.sort((a, b) => a.line - b.line);
  return {
    received,
    created,
    errors: errors.slice(0, IMPORT_ERROR_LIMIT),
    errorCount: errors.length,
  };
}
