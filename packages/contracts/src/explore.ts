// The Explore screen's three reads (X02-R1..R3): an item list by name, one item's neighbourhood, and a source
// version read by its version id. All answer from the read gate; a hidden item, fact, relation or version is in
// none of them, and one asked for by number is the same `not-found` as a number nothing is stored under (R4).
// The row shapes mirror the Semantic list's (`SemanticFactSchema`, `SemanticRelationSchema` in index.ts) with the
// valid interval added; this file cannot import them (index.ts re-exports this file), so the enums are spelled here.
import { z } from "zod";
import { AttachmentSchema, NativeLocatorSchema } from "./connector.ts";

/** X02-D5: items per page. No total is ever answered: a count would include what the gate hides. */
export const EXPLORE_PAGE_SIZE = 50;
/** The longest name search, in characters. */
export const EXPLORE_QUERY_MAX = 200;

export const ExploreItemsRequestSchema = z.strictObject({
  query: z.string().max(EXPLORE_QUERY_MAX).optional(),
  /** The last item id of the previous page (the previous answer's `next`). */
  after: z.int().nonnegative().optional(),
});
const ExploreItemRefSchema = z.object({
  id: z.int().positive(),
  type: z.string(),
  name: z.string(),
});
export const ExploreItemsResponseSchema = z.object({
  /** `alias` (X02B-R1): the first shown alias that matched when the name did not; null for a name match. */
  items: z.array(ExploreItemRefSchema.extend({ alias: z.string().nullable() })),
  next: z.int().positive().nullable(),
});

export const ExploreItemRequestSchema = z.strictObject({
  itemId: z.int().positive(),
  /** Any positive int parses; above GRAPH_MAX_DEPTH the answer is the `depth-exceeded` refusal, as `graphPaths` gives it. */
  depth: z.int().positive(),
});
const Status = z.enum(["candidate", "verified", "disputed", "superseded", "rejected"]);
const Epistemic = z.enum(["explicit", "user-approved", "inferred", "hypothesis"]);
const Row = {
  id: z.int().positive(),
  status: Status,
  epistemic: Epistemic,
  confidence: z.number().min(0).max(1).nullable(),
  userDecided: z.boolean(),
  userAuthored: z.boolean(),
  evidenceCount: z.int().nonnegative(),
  validAt: z.string().nullable(),
  validUntil: z.string().nullable(),
};
export const ExploreFactSchema = z.object({
  ...Row,
  /** The item that holds the fact: the centre or one of its members (X02F-R2). */
  itemId: z.int().positive(),
  kind: z.string(),
  value: z.string(),
  context: z.string().nullable(),
});
export const ExploreRelationSchema = z.object({
  ...Row,
  type: z.string(),
  subjectId: z.int().positive(),
  objectId: z.int().positive(),
});
const ExploreEdgeSchema = z.object({
  relationId: z.int().positive(),
  type: z.string(),
  direction: z.enum(["forward", "backward"]),
  from: z.int().positive(),
  to: z.int().positive(),
  /** The first step (1-based) a path over this relation reaches it at. */
  step: z.int().positive(),
});
/** `ok` carries the neighbourhood; `refused` carries `reason` (a refusal is a code in a 200 body, as `graphPaths` gives it). */
export const ExploreItemResponseSchema = z
  .object({
    status: z.enum(["ok", "refused"]),
    reason: z.literal("depth-exceeded").optional(),
    center: ExploreItemRefSchema.extend({
      /** The Wiki page of the item, when one is stored and shown. */
      wikiKey: z.string().nullable(),
      /** The shown active members of the item's group, ascending by id (X02B-R2); `mergeId` is what an unmerge takes, null when its line points at an item not shown. */
      members: z.array(ExploreItemRefSchema.extend({ mergeId: z.int().positive().nullable() })),
      facts: z.array(ExploreFactSchema),
      relations: z.array(ExploreRelationSchema),
    }).optional(),
    items: z.array(ExploreItemRefSchema).optional(),
    edges: z.array(ExploreEdgeSchema).optional(),
    truncated: z.boolean().optional(),
  })
  .refine((o) =>
    o.status === "ok"
      ? o.center !== undefined &&
        o.items !== undefined &&
        o.edges !== undefined &&
        o.truncated !== undefined &&
        o.reason === undefined
      : o.reason !== undefined &&
        o.center === undefined &&
        o.items === undefined &&
        o.edges === undefined &&
        o.truncated === undefined,
  );

/** X02B-R2: item names by number; a missing or hidden number is left out, not refused. */
export const EXPLORE_NAMES_MAX = 200;
export const ExploreNamesRequestSchema = z.strictObject({
  ids: z.array(z.int().positive()).min(1).max(EXPLORE_NAMES_MAX),
});
export const ExploreNamesResponseSchema = z.object({ items: z.array(ExploreItemRefSchema) });

export const ExploreSourceRequestSchema = z.strictObject({
  versionId: z.int().positive(),
  /** X02B-R5: a code point of `body`; with it the answer carries the locator and attachment of the block holding it. */
  start: z.int().nonnegative().optional(),
});
/** The same fields as `EvidenceSourceResponseSchema.sourceVersion`. The body is imported, untrusted text. */
export const ExploreSourceResponseSchema = z.object({
  sourceVersion: z.object({
    id: z.int().positive(),
    version: z.int().positive(),
    latestVersion: z.int().positive(),
    title: z.string(),
    body: z.string(),
  }),
  /** Both null without `start` (or for a gap), as in `EvidenceSourceResponseSchema`. */
  locator: NativeLocatorSchema.nullable(),
  attachment: AttachmentSchema.nullable(),
});
