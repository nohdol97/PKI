// Connector adapter (ARCHITECTURE 5.5, V01-R7). The Connector management module
// calls getChanges repeatedly and commits the cursor only after saving each page.
// Records are strict: a Connector cannot attach a data class (ADR 0014); the
// Broker computes it from the canonical store.
import { z } from "zod";

export const CONNECTOR_NOT_IMPLEMENTED = "미구현, 배포처 후속";

/** Raised by the public repository's placeholders for site Connectors (V01-R18). */
export class ConnectorNotImplementedError extends Error {
  constructor() {
    super(CONNECTOR_NOT_IMPLEMENTED);
    this.name = "ConnectorNotImplementedError";
  }
}

export const SourceRecordSchema = z.strictObject({
  externalId: z.string().min(1),
  title: z.string(),
  body: z.string(),
  /**
   * The Connector's own version of this record, when it numbers them (a JSONL line's
   * `version`). Storage keeps it beside its own version number and uses it only to
   * order arrivals (V02-R2).
   */
  revision: z.int().min(1).optional(),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const ChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upsert"), record: SourceRecordSchema }),
  z.strictObject({
    kind: z.enum(["delete", "access-revoked"]),
    externalId: z.string().min(1),
    version: z.int(),
    at: z.string(),
  }),
]);
export type Change = z.infer<typeof ChangeSchema>;

export const ChangeSetSchema = z.strictObject({
  changes: z.array(ChangeSchema),
  nextCursor: z.string(),
  hasMore: z.boolean(),
  /** The given cursor is no longer valid: the caller rescans from null. */
  cursorExpired: z.boolean().optional(),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

export type HealthStatus = { state: "ok" } | { state: "unavailable"; reason: string };

export interface ConnectorManifest {
  type: string;
  schemaVersion: number;
  capabilities: {
    incremental: boolean;
    deletes: boolean;
    accessScope: boolean;
    fullRescan: boolean;
  };
}

export interface Connector {
  readonly manifest: ConnectorManifest;
  /** Unimplemented integrations fail with ConnectorNotImplementedError. */
  initialize(config: unknown): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  getChanges(
    cursor: string | null,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<ChangeSet>;
  getDocument(externalId: string): Promise<SourceRecord | null>;
}
