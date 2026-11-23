// The Ask request and its events (X01-R10). `POST /api/ask` answers with newline-delimited JSON: one event per
// line, in the order route, hits, answer, sentence (none or more), done. A client closing the connection is
// the cancel; nothing is written after it. Every event is shown content: a hit, a count, a title or a link of
// something the registry hides is in none of them (R12).
import { z } from "zod";

const Rows = z.int().nonnegative();

/** The most question text one request carries, in characters (provisional). */
export const ASK_QUESTION_MAX = 2000;

const IsoTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a date");

export const AskRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(ASK_QUESTION_MAX),
  /** Whether to ask the Provider for an answer; false gives the route and the hits only. */
  answer: z.boolean(),
  /** The metadata strategy's filter fields (R1): collector instances and the origin system's time range. */
  connectorIds: z.array(z.string().min(1)).max(50).optional(),
  from: IsoTime.optional(),
  to: IsoTime.optional(),
  /** The user's confirmation of the unverified-isolation warning for this one call, as the connection test takes it. */
  acknowledgeUnverified: z.boolean().optional(),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

/** What a strategy did (R2); `unavailable` names why. No count: a list's size would include what a gate hides. */
export const AskRouteEntrySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("used") }),
  z.strictObject({ status: z.literal("skipped") }),
  z.strictObject({ status: z.literal("off") }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.string().min(1) }),
]);

export const AskRelatedSchema = z.strictObject({
  itemId: z.int(),
  name: z.string(),
  wikiKey: z.string().nullable(),
  wikiTitle: z.string().nullable(),
});

export const AskHitSchema = z.strictObject({
  versionId: z.int(),
  sourceId: z.int(),
  version: z.int(),
  /** 1-based over the hits shown. */
  rank: z.int().positive(),
  title: z.string(),
  /** The strategies whose list held it. */
  strategies: z.array(z.string()),
  related: z.array(AskRelatedSchema),
});

/** R6: a mark names only the hit's source version. */
export const AskNoteSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("insufficient") }),
  z.strictObject({ kind: z.enum(["conflict", "stale"]), versionId: z.int() }),
]);

export const AskEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("route"), route: z.record(z.string(), AskRouteEntrySchema) }),
  z.strictObject({
    type: z.literal("hits"),
    hits: z.array(AskHitSchema),
    notes: z.array(AskNoteSchema),
  }),
  /**
   * The answer's state, once. `started`: sentences follow (none when none were confirmed). `none`: no answer was
   * asked for, or no document was left to send (`reason` `not-requested` or `insufficient`). `blocked`: consent,
   * policy, execution condition or no Provider (`reason` is the Broker's code, e.g. `no-provider`). `failed`:
   * the call or the check failed. `cancelled`: the call was ended without the connection closing.
   */
  z.strictObject({
    type: z.literal("answer"),
    status: z.enum(["started", "none", "blocked", "failed", "cancelled"]),
    reason: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal("sentence"),
    text: z.string(),
    /** The quote as the stored body of that version holds it, with its code point span `[start, end)` (R9). */
    citation: z.strictObject({
      versionId: z.int(),
      sourceId: z.int(),
      version: z.int(),
      start: Rows,
      end: Rows,
      quote: z.string(),
    }),
  }),
  z.strictObject({
    type: z.literal("done"),
    /** Sentences sent, and sentences dropped because their quote was not found once in the document (R9). */
    sentences: Rows,
    dropped: Rows,
    /** An answer was asked for and no confirmed sentence came out of it (R6 `insufficient`). */
    insufficient: z.boolean(),
  }),
]);
export type AskEvent = z.infer<typeof AskEventSchema>;

/**
 * The route's row. It is not in `routes`: that table's responses are one JSON body each and every one of them is
 * checked as such (the contract test over `routes`), while this one answers a stream of events.
 */
export const askRoute = {
  method: "POST",
  path: "/api/ask",
  request: AskRequestSchema,
  event: AskEventSchema,
} as const;
