// One line of a JSONL import file (V02-R1): the R05 golden SourceRecord shape,
// i.e. the original design's SourceRecord plus `connector_instance_id`,
// `operation` and `schema_version`. The field rules follow
// eval/scorer/validate.py `check_record`; providers/src/import-record.test.ts runs every
// golden source through this schema so the two stay one shape.
// `malicious: true` marks a synthetic malicious variant for the synthetic
// manifest only; a Connector drops it, since SourceRecordSchema rejects it.
import { z } from "zod";

const isoWithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const ImportRecordSchema = z
  .strictObject({
    id: z.string().min(1),
    source_type: z.enum(["mail", "wiki", "messenger"]),
    external_id: z.string().min(1),
    title: z.string(),
    content: z.string(),
    author: z.string(),
    participants: z.array(z.string()),
    thread_id: z.string(),
    source_url: z.string(),
    created_at: z.string().regex(isoWithOffset),
    updated_at: z.string().regex(isoWithOffset),
    content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    version: z.int().min(1),
    access_scope: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()),
    connector_instance_id: z.string().min(1),
    operation: z.enum(["upsert", "delete", "revoke"]),
    schema_version: z.literal("1"),
    malicious: z.literal(true).optional(),
  })
  .refine((r) => r.operation !== "delete" || r.content === "", {
    message: "a delete line carries empty content",
    path: ["content"],
  });
export type ImportRecord = z.infer<typeof ImportRecordSchema>;

/**
 * Why an import line was not stored (V02-R2). Format: `invalid-json`,
 * `invalid-record` (the schema; `field` names the first failing known field),
 * `content-hash-mismatch` (not the sha256 of `content`). Arrival order:
 * `revision-not-newer` (an equal or lower version with other content).
 * `tombstoned`: a deleted or revoked source the tombstone blocks (V02-R12: every
 * version at or below it, which after a purge is every version). `instance-conflict`:
 * the `connector_instance_id` belongs to another Connector kind.
 * `too-many-instances`: past the cap of distinct instances per file (provisional).
 * `instance-failed`: its instance's sync failed (e.g. a job registration conflict)
 * and the line was not stored.
 */
export const ImportLineErrorReasonSchema = z.enum([
  "invalid-json",
  "invalid-record",
  "content-hash-mismatch",
  "revision-not-newer",
  "tombstoned",
  "instance-conflict",
  "too-many-instances",
  "instance-failed",
]);
export type ImportLineErrorReason = z.infer<typeof ImportLineErrorReasonSchema>;

export const ImportLineErrorSchema = z.strictObject({
  /** 1-based line number in the imported text. */
  line: z.int().min(1),
  reason: ImportLineErrorReasonSchema,
  field: z.string().optional(),
});
export type ImportLineError = z.infer<typeof ImportLineErrorSchema>;

export const ImportJsonlRequestSchema = z.strictObject({ text: z.string() });

/**
 * `received` counts changes read; `created` the new source versions; `errors` the
 * first refused lines by line number (capped, provisional 100); `errorCount` all of them.
 */
export const ImportJsonlResponseSchema = z.object({
  received: z.int().nonnegative(),
  created: z.int().nonnegative(),
  errors: z.array(ImportLineErrorSchema),
  errorCount: z.int().nonnegative(),
});
export type ImportJsonlResponse = z.infer<typeof ImportJsonlResponseSchema>;
