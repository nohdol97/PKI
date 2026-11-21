// JSONL import (V02-R2): the Sources screen's import of one JSONL text. Each
// `connector_instance_id` in it is synced as its own instance of the JSONL
// Connector (kind `jsonl-import`) from the start of the text, so importing the
// same text again reads every line and stores nothing new (C3 reimport). Every
// refused line is reported by its number: malformed ones by the parser, the ones
// the store refuses by the sync (connectors.ts), and the lines of an instance
// already bound to another Connector kind.
import type { Connector, ImportJsonlResponse, ImportLineError } from "@pki/contracts";
import { readConnectorKind, type SqlDriver } from "@pki/storage";
import { syncConnector, type SyncOptions } from "./connectors.ts";
import { parseJsonl } from "./jsonl-lines.ts";

export const JSONL_CONNECTOR_KIND = "jsonl-import";

export type JsonlImporter = (text: string) => Promise<ImportJsonlResponse>;

export interface ImportOptions extends Pick<SyncOptions, "runner"> {
  /** The JSONL Connector, chosen by the composition point (composition.ts). */
  createConnector: () => Connector;
}

export async function importJsonl(
  db: SqlDriver,
  text: string,
  options: ImportOptions,
): Promise<ImportJsonlResponse> {
  const { lines, errors } = parseJsonl(text);
  const instances = new Map<string, Map<string, number>>();
  for (const { line, record } of lines) {
    const byExternalId = instances.get(record.connector_instance_id) ?? new Map();
    byExternalId.set(record.external_id, line);
    instances.set(record.connector_instance_id, byExternalId);
  }
  const lineErrors: ImportLineError[] = [...errors];
  let received = 0;
  let created = 0;
  for (const [instanceId, lineOf] of instances) {
    const bound = readConnectorKind(db, instanceId);
    if (bound !== undefined && bound !== JSONL_CONNECTOR_KIND) {
      for (const line of lineOf.values()) lineErrors.push({ line, reason: "instance-conflict" });
      continue;
    }
    const connector = options.createConnector();
    await connector.initialize({ text, connectorInstanceId: instanceId });
    const result = await syncConnector(db, instanceId, JSONL_CONNECTOR_KIND, connector, {
      ...(options.runner ? { runner: options.runner } : {}),
      rescan: true,
      onRefused: (change, reason) => {
        const externalId = change.kind === "upsert" ? change.record.externalId : change.externalId;
        lineErrors.push({ line: lineOf.get(externalId) as number, reason });
      },
    });
    received += result.received;
    created += result.created;
  }
  return { received, created, errors: lineErrors.sort((a, b) => a.line - b.line) };
}
