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
