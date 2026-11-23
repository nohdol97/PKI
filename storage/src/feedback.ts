// The feedback record and the preference signal (P03). One table, `feedback`: a kind, the one row it is
// about (an Insight, item, fact or relation), the times and, for a correction, the history line it wrote.
// What a kind may be given to and what it does comes from the contracts' kind table alone (R1).
//
// A correction ("this knowledge is wrong/right") goes through the user's entry (`UserDecisions`, handed in
// by the caller) and no SQL here changes a knowledge row (R4). A preference ("useful to me / not") writes
// this table only: it never touches the knowledge rows, their histories or the Insights (R6). The signal
// (`preferenceSignals`) is computed on read from the live lines; nothing is stored back (R7).
// The transaction is the caller's. `shown` is the caller's answer to "may this target be seen now": a
// target it refuses answers `not-found`, the same as an absent one (R10).
import {
  FEEDBACK_KINDS,
  FEEDBACK_TABLE,
  feedbackClass,
  type FeedbackClass,
  type FeedbackKind,
  type FeedbackTarget,
  type FeedbackTargetKind,
} from "@pki/contracts";
import type { DataCheckUnmet } from "./analytical-gate.ts";
import { withGroups } from "./entity-groups.ts";
import { readRow, stateLinesOf, type EntryRef, type Refusal } from "./semantic-lifecycle.ts";
import type { UserDecisions } from "./semantic-user.ts";
import { readSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** The setting that turns the type step of the signal on; exactly `on` (P03-D7, dark launch). */
export const FEEDBACK_LEARNED_SETTING = "feedback.learned";

/** The type step shrinks toward 0 while lines are few: `round(100 × (pos − neg) / (pos + neg + K))` (P03-D7). */
const TYPE_SMOOTHING = 3;

const COLUMN: Record<FeedbackTargetKind, string> = {
  insight: "insight_id",
  item: "item_id",
  fact: "fact_id",
  relation: "relation_id",
};
const TABLE: Record<FeedbackTargetKind, string> = {
  insight: "insights",
  item: "items",
  fact: "facts",
  relation: "relations",
};
const TARGET_KINDS = Object.keys(COLUMN) as FeedbackTargetKind[];

/** The likes and dislikes: the kinds that carry a weight. */
const OPINIONS = FEEDBACK_KINDS.filter((kind) => FEEDBACK_TABLE[kind].weight !== 0);
/** On an Insight these hide it until its content changes (P03-R7, D4). */
const HIDE_UNTIL_CHANGED: readonly FeedbackKind[] = ["already_known", "confirmed"];

export interface StoredFeedback {
  id: number;
  kind: FeedbackKind;
  target: FeedbackTarget;
  createdAt: string;
  /** The history line a correction wrote; null for a preference or a correction that changed nothing. */
  appliedSeq: number | null;
}

/** The two operations of the user's entry that feedback calls; what the API layer may name in place of the entry itself. */
export type FeedbackEntries = Pick<UserDecisions, "decide" | "undo">;

export interface FeedbackInput {
  target: FeedbackTarget;
  kind: FeedbackKind;
}

export interface FeedbackOptions {
  /** Whether the caller may see the target now; a refused target is `not-found`. */
  shown?: (target: FeedbackTarget) => boolean;
}

export type RecordResult =
  | {
      status: "applied";
      feedback: StoredFeedback;
      /** false when a live line of that kind and target existed and was answered as it is */
      created: boolean;
      /** The knowledge row a correction changed, for the caller's re-judging; null when nothing changed. */
      touched: EntryRef | null;
    }
  | {
      status: "refused";
      reason: "bad-request" | "not-found" | Refusal | "data-check-unmet";
      unmet?: readonly DataCheckUnmet[];
    };

export type UndoFeedbackResult =
  | { status: "applied"; feedback: StoredFeedback; touched: EntryRef | null }
  | { status: "refused"; reason: "not-found" | Refusal };

const rowOf = (r: Record<string, unknown>): StoredFeedback => {
  const target = TARGET_KINDS.find((k) => r[COLUMN[k]] !== null) as FeedbackTargetKind;
  return {
    id: r.id as number,
    kind: r.kind as FeedbackKind,
    target: { kind: target, id: r[COLUMN[target]] as number },
    createdAt: r.created_at as string,
    appliedSeq: r.applied_seq as number | null,
  };
};

const exists = (db: SqlDriver, t: FeedbackTarget) =>
  db.all(`SELECT 1 FROM ${TABLE[t.kind]} WHERE id = ?`, [t.id]).length === 1;

/** Writes (or answers) one line. The correction path is the only one that reaches the user's entry. */
export function recordFeedback(
  tx: SqlDriver,
  decisions: FeedbackEntries,
  input: FeedbackInput,
  at: string,
  options: FeedbackOptions = {},
): RecordResult {
  const { target, kind } = input;
  const cls: FeedbackClass | undefined = feedbackClass(kind, target.kind);
  if (!cls) return { status: "refused", reason: "bad-request" };
  if (!exists(tx, target) || options.shown?.(target) === false) {
    return { status: "refused", reason: "not-found" };
  }
  const ref: EntryRef = { kind: target.kind as EntryRef["kind"], id: target.id };
  // what a correction asks of the entry now: nothing when the row is already where the kind wants it
  const status = cls === "correction" ? readRow(tx, ref)?.status : undefined;
  const action =
    cls !== "correction"
      ? null
      : FEEDBACK_TABLE[kind].action === "approve"
        ? status === "verified"
          ? null
          : "approve"
        : status === "verified"
          ? "dispute"
          : status === "candidate"
            ? "reject"
            : null;
  const live = tx.all(
    `SELECT * FROM feedback WHERE kind = ? AND ${COLUMN[target.kind]} = ? AND undone_at IS NULL`,
    [kind, target.id],
  )[0];
  let stale: StoredFeedback | undefined;
  if (live) {
    const line = rowOf(live);
    // A live line is answered as it is only while its effect holds: a preference always; a like or dislike while
    // it is still the newest of the three (D9); a correction while its history line is still the row's newest, or,
    // with no line, while the row still needs no action. Otherwise it is cancelled below, once the entry has accepted
    // the new one (a refusal leaves everything as it was), and a new line is written.
    const holds =
      cls === "correction"
        ? line.appliedSeq === null
          ? action === null
          : stateLinesOf(tx, ref).at(-1)?.seq === line.appliedSeq
        : !OPINIONS.includes(kind) ||
          (
            tx.all(
              `SELECT id FROM feedback WHERE ${COLUMN[target.kind]} = ? AND undone_at IS NULL
                AND kind IN (${placeholders(OPINIONS)}) ORDER BY id DESC LIMIT 1`,
              [target.id, ...OPINIONS],
            )[0] as { id: number }
          ).id === line.id;
    if (holds) return { status: "applied", feedback: line, created: false, touched: null };
    stale = line;
  }
  let seq: number | null = null;
  let touched: EntryRef | null = null;
  if (cls === "correction") {
    if (action) {
      const outcome = decisions.decide(tx, ref, action, at);
      if (outcome.status === "refused") {
        return "unmet" in outcome
          ? { status: "refused", reason: outcome.reason, unmet: outcome.unmet }
          : { status: "refused", reason: outcome.reason };
      }
      if (outcome.status === "applied") {
        seq = outcome.seq;
        touched = ref;
      }
    }
  }
  if (stale) tx.run("UPDATE feedback SET undone_at = ? WHERE id = ?", [at, stale.id]);
  const id = tx.run(
    `INSERT INTO feedback (kind, ${COLUMN[target.kind]}, created_at, applied_seq) VALUES (?, ?, ?, ?)`,
    [kind, target.id, at, seq],
  ).lastInsertRowid;
  const stored = tx.all("SELECT * FROM feedback WHERE id = ?", [id])[0] as Record<string, unknown>;
  return { status: "applied", feedback: rowOf(stored), created: true, touched };
}

/**
 * Cancels one live line. A preference only gets an undone time. A correction that changed a row is taken back
 * through the entry's undo, and only while its history line is still the row's newest: after another action the
 * answer is `not-latest` and nothing changes (R5).
 */
export function undoFeedback(
  tx: SqlDriver,
  decisions: FeedbackEntries,
  id: number,
  at: string,
  options: FeedbackOptions = {},
): UndoFeedbackResult {
  const found = tx.all("SELECT * FROM feedback WHERE id = ?", [id])[0];
  if (!found || options.shown?.(rowOf(found).target) === false) {
    return { status: "refused", reason: "not-found" };
  }
  const feedback = rowOf(found);
  if (found.undone_at !== null) return { status: "refused", reason: "nothing-to-undo" };
  let touched: EntryRef | null = null;
  if (feedback.appliedSeq !== null) {
    const ref = feedback.target as EntryRef;
    if (stateLinesOf(tx, ref).at(-1)?.seq !== feedback.appliedSeq) {
      return { status: "refused", reason: "not-latest" };
    }
    const outcome = decisions.undo(tx, ref, at);
    if (outcome.status === "refused") return { status: "refused", reason: outcome.reason };
    touched = ref;
  }
  tx.run("UPDATE feedback SET undone_at = ? WHERE id = ?", [at, id]);
  return { status: "applied", feedback, touched };
}

/** The live lines, newest first, those whose target `usable` accepts, at most `limit`. */
export function listFeedback(
  db: SqlDriver,
  limit: number,
  usable: (target: FeedbackTarget) => boolean = () => true,
): StoredFeedback[] {
  const listed: StoredFeedback[] = [];
  for (const row of db.all("SELECT * FROM feedback WHERE undone_at IS NULL ORDER BY id DESC")) {
    const f = rowOf(row);
    if (listed.length >= limit) break;
    if (usable(f.target)) listed.push(f);
  }
  return listed;
}

export const feedbackLearned = (db: SqlDriver): boolean =>
  readSetting(db, FEEDBACK_LEARNED_SETTING) === "on";

export interface PreferenceSignal {
  /** −100..100, an integer; 0 is no opinion. */
  weight: number;
  /** The step the weight came from, for explanation. */
  source: "direct" | "item" | "type" | null;
  /** Left out of the user's feed. */
  hidden: boolean;
  /** No notification is sent. */
  muted: boolean;
}

export interface SignalOptions {
  /** The type step runs only when true; default is the setting. */
  learned?: boolean;
  /** Whether a target's lines may be used (the caller's visibility); a refused target counts for nothing. */
  usable?: (target: FeedbackTarget) => boolean;
}

const NEUTRAL: PreferenceSignal = { weight: 0, source: null, hidden: false, muted: false };

const placeholders = (kinds: readonly string[]) => kinds.map(() => "?").join(", ");

/** The signal of each target (an Insight or an item), in the order given; same input, same value. */
export function preferenceSignals(
  db: SqlDriver,
  targets: readonly FeedbackTarget[],
  options: SignalOptions = {},
): PreferenceSignal[] {
  const learned = options.learned ?? feedbackLearned(db);
  const usable = options.usable ?? (() => true);
  const liveLines = (t: FeedbackTarget, kinds: readonly FeedbackKind[]) =>
    db.all(
      `SELECT kind, created_at FROM feedback
        WHERE ${COLUMN[t.kind]} = ? AND undone_at IS NULL AND kind IN (${placeholders(kinds)})
        ORDER BY id DESC`,
      [t.id, ...kinds],
    ) as { kind: FeedbackKind; created_at: string }[];
  /** The newest like or dislike of one usable target, if any. */
  const opinion = (t: FeedbackTarget): FeedbackKind | undefined =>
    usable(t) ? liveLines(t, OPINIONS)[0]?.kind : undefined;
  const muteOn = (t: FeedbackTarget) => usable(t) && liveLines(t, ["mute"]).length > 0;
  const typeLines = new Map<string, { kind: FeedbackKind; insight: number }[]>();
  const ofType = (rule: string) => {
    if (!typeLines.has(rule)) {
      typeLines.set(
        rule,
        (
          db.all(
            `SELECT f.kind, f.insight_id FROM feedback f JOIN insights i ON i.id = f.insight_id
              WHERE i.rule = ? AND f.undone_at IS NULL AND f.kind IN (${placeholders(OPINIONS)})`,
            [rule, ...OPINIONS],
          ) as { kind: FeedbackKind; insight_id: number }[]
        )
          .filter((r) => usable({ kind: "insight", id: r.insight_id }))
          .map((r) => ({ kind: r.kind, insight: r.insight_id })),
      );
    }
    return typeLines.get(rule) as { kind: FeedbackKind; insight: number }[];
  };

  return targets.map((target): PreferenceSignal => {
    if (target.kind === "item") {
      const own = opinion(target);
      return {
        ...NEUTRAL,
        ...(own ? { weight: FEEDBACK_TABLE[own].weight, source: "direct" as const } : {}),
        muted: muteOn(target),
      };
    }
    const row = db.all("SELECT rule, x_item_id, y_item_id, changed_at FROM insights WHERE id = ?", [
      target.id,
    ])[0];
    if (!row) return NEUTRAL;
    const bundle = withGroups(db, [row.x_item_id as number, row.y_item_id as number]).map(
      (id): FeedbackTarget => ({ kind: "item", id }),
    );
    const own = opinion(target);
    const changedAt = row.changed_at === null ? -Infinity : Date.parse(row.changed_at as string);
    const unchangedSince =
      usable(target) &&
      liveLines(target, HIDE_UNTIL_CHANGED).some((l) => Date.parse(l.created_at) >= changedAt);
    const hidden = own === "irrelevant" || unchangedSince;
    const muted = hidden || muteOn(target) || bundle.some(muteOn);

    let weight = 0;
    let source: PreferenceSignal["source"] = null;
    if (own) {
      weight = FEEDBACK_TABLE[own].weight;
      source = "direct";
    } else {
      // the item step: the largest absolute direct weight among the bundle's items, a tie going to the negative
      const weights = bundle
        .map(opinion)
        .flatMap((kind) => (kind ? [FEEDBACK_TABLE[kind].weight] : []));
      if (weights.length > 0) {
        weight = weights.reduce((best, w) =>
          Math.abs(w) > Math.abs(best) || (Math.abs(w) === Math.abs(best) && w < best) ? w : best,
        );
        source = "item";
      } else if (learned) {
        const lines = ofType(row.rule as string);
        const positive = lines.filter((l) => FEEDBACK_TABLE[l.kind].weight > 0).length;
        const negative = lines.length - positive;
        weight = Math.round((100 * (positive - negative)) / (lines.length + TYPE_SMOOTHING));
        source = weight === 0 ? null : "type";
      }
    }
    return { weight, source, hidden, muted };
  });
}
