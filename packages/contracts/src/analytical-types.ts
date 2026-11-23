// The analytical semantic's read API and its check request (S03-R19, T08): `GET /api/analytical` and
// `POST /api/analytical/check`, and the value a `/correct` request may give in pieces (S03-R3). Every shape is
// closed (strict objects): no field takes a query, an expression or a free combination of column names (S03-R18),
// and no response carries a computed value. An error is a closed code of `ErrorResponseSchema` and the refusal
// code `data-check-unmet` (in index.ts) with names of conditions only, never a name, value or quote (S01-R23).
// Not exported from index.ts until the peers' contract changes are merged (the wiring list in the T08 report).
import { z } from "zod";
import { DATA_CHECK_NAMES } from "./knowledge-schema.ts";

const Id = z.int().positive();
const Count = z.int().nonnegative();
const Status = z.enum(["candidate", "verified", "disputed", "superseded", "rejected"]);
const Epistemic = z.enum(["explicit", "user-approved", "inferred", "hypothesis"]);

/** The conditions a check-needing row may lack: the same names as the refusal `data-check-unmet` lists. */
export const ANALYTICAL_UNMET = [
  "no-dataset",
  "spec-conflict",
  "check-missing",
  ...DATA_CHECK_NAMES,
] as const;

const CheckResult = z.strictObject({
  check: z.enum(DATA_CHECK_NAMES),
  passed: z.boolean(),
  failure: z.string().nullable(),
  examined: Count,
  violations: Count,
  skipped: Count,
});

/** A fact row with its registry state (S01), its evidence, and for a check-needing kind its checks and conditions. */
export const AnalyticalFactSchema = z.strictObject({
  id: Id,
  kind: z.string(),
  value: z.string(),
  context: z.string().nullable(),
  status: Status,
  epistemic: Epistemic,
  confidence: z.number().min(0).max(1).nullable(),
  userDecided: z.boolean(),
  userAuthored: z.boolean(),
  evidenceIds: z.array(Id),
  evidenceCount: Count,
  checkNeeded: z.boolean(),
  checks: z.array(CheckResult),
  unmet: z.array(z.enum(ANALYTICAL_UNMET)),
  /** The sources whose extraction the row waits on (S03-R16): "추출을 기다림". */
  awaitingSourceIds: z.array(Id),
});

const AnalyticalRelationSchema = z.strictObject({
  id: Id,
  type: z.string(),
  subjectId: Id,
  objectId: Id,
  status: Status,
  epistemic: Epistemic,
  confidence: z.number().min(0).max(1).nullable(),
  userDecided: z.boolean(),
  userAuthored: z.boolean(),
  evidenceIds: z.array(Id),
  evidenceCount: Count,
});

const Conflict = z.strictObject({
  kind: z.string(),
  rowKind: z.enum(["fact", "relation", "item"]),
  ids: z.array(Id).min(2),
});
const Table = z.strictObject({
  tableId: Id,
  sourceId: Id,
  rowCount: Count,
  limitations: z.array(z.string()),
});
const DatasetRef = z.strictObject({
  itemId: Id,
  name: z.string(),
  tables: z.array(Table),
  groupTableItemIds: z.array(Id),
  representativeLacksTable: z.boolean(),
});
const ColumnMatch = z.strictObject({
  column: z.string().nullable(),
  factId: Id.nullable(),
  missing: z.enum(["column-missing", "no-table"]).nullable(),
});
const ItemBase = {
  itemId: Id,
  name: z.string(),
  status: Status,
  epistemic: Epistemic,
  userDecided: z.boolean(),
  userAuthored: z.boolean(),
  conflicts: z.array(Conflict),
};
const Named = z.strictObject({ itemId: Id, name: z.string() });

export const AnalyticalMetricSchema = z.strictObject({
  ...ItemBase,
  terms: z.array(AnalyticalFactSchema),
  definitions: z.array(AnalyticalFactSchema),
  calculations: z.array(AnalyticalFactSchema),
  calculationConfirmed: z.boolean(),
  datasets: z.array(DatasetRef),
  columns: z.array(ColumnMatch),
  grain: z.array(AnalyticalFactSchema),
  joins: z.array(Named),
  units: z.array(AnalyticalFactSchema),
  currencies: z.array(AnalyticalFactSchema),
  periods: z.array(AnalyticalFactSchema),
  versions: z.array(AnalyticalFactSchema),
  relations: z.array(AnalyticalRelationSchema),
});
const datasetShape = {
  ...ItemBase,
  tables: z.array(Table),
  columns: z.array(AnalyticalFactSchema),
  roles: z.array(AnalyticalFactSchema),
  grain: z.array(AnalyticalFactSchema),
  measures: z.array(AnalyticalFactSchema),
  dimensions: z.array(AnalyticalFactSchema),
  timeDimensions: z.array(AnalyticalFactSchema),
  groupTableItemIds: z.array(Id),
  representativeLacksTable: z.boolean(),
};
export const AnalyticalDatasetSchema = z.strictObject({
  ...datasetShape,
  /** The group's members under their representative (S02-R13); a member's own `members` is empty. */
  members: z.array(z.strictObject({ ...datasetShape, members: z.array(z.never()) })),
});
export const AnalyticalJoinSchema = z.strictObject({
  ...ItemBase,
  left: z.array(Named),
  right: z.array(Named),
  keys: z.array(AnalyticalFactSchema),
  cardinality: z.array(AnalyticalFactSchema),
  relations: z.array(AnalyticalRelationSchema),
});
export const AnalyticalListSchema = z.strictObject({
  datasets: z.array(AnalyticalDatasetSchema),
  metrics: z.array(AnalyticalMetricSchema),
  joins: z.array(AnalyticalJoinSchema),
  truncated: z.boolean(),
});
export type AnalyticalList = z.infer<typeof AnalyticalListSchema>;

/** The check request names an item and nothing else (S03-R18: no query, no expression, no column list). */
export const AnalyticalCheckRequestSchema = z.strictObject({ itemId: Id });
/** The jobs queued or reused, one per table source the item reaches, by source id; none when no table is reached. */
export const AnalyticalCheckResponseSchema = z.strictObject({ jobIds: z.array(Id) });

/**
 * A value of a kind of several pieces, as the pieces: a column set or key pairs as a list, a calculation as an
 * object. The server normalises it by the kind's value type (S03-R3) and stores the canonical text; a value that
 * is not one of the type is `bad-request`. A plain text is the older form and stays in the request schemas.
 */
export const SemanticPiecesSchema = z.union([
  z.array(z.unknown()).max(50),
  z.record(z.string(), z.unknown()),
]);
