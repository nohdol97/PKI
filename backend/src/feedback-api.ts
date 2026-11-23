// The feedback routes (P03-R9, R10, R14): record, undo and list, and the feed's hiding of Insights the user
// marked. Every read and write first asks whether the target is shown now (the read gate): a target that is
// absent, deleted or hidden answers the same `not-found`, and the list and the signals use the lines of shown
// targets alone, so nothing of a hidden row shows in an answer. A correction runs the user's entry in one
// transaction and then the same re-judging as any user action (`judgeAgain`). Logic lives in
// storage/src/feedback.ts; this file is the visibility, the labels and the response shapes.
import {
  feedbackClass,
  type ErrorResponse,
  type FeedbackLine,
  type FeedbackTarget,
  type RouteRequest,
  type RouteResponse,
} from "@pki/contracts";
import {
  FEEDBACK_LEARNED_SETTING,
  feedbackLearned,
  itemsOfEntry,
  listFeedback,
  preferenceSignals,
  readSemanticState,
  recordFeedback,
  undoFeedback,
  writeSetting,
  type EntryRef,
  type FeedbackEntries,
  type SqlDriver,
  type StoredFeedback,
} from "@pki/storage";
import type { ReadGate } from "./read-gate.ts";

/** The most lines the list answers (P03-R14). */
const LIST_LIMIT = 100;

type Answer<Name extends "feedbackRecord" | "feedbackUndo"> =
  RouteResponse<Name> | { error: ErrorResponse["error"] };

export interface FeedbackApi {
  record(request: RouteRequest<"feedbackRecord">, at: string): Answer<"feedbackRecord">;
  undo(request: RouteRequest<"feedbackUndo">, at: string): Answer<"feedbackUndo">;
  list(): RouteResponse<"feedbackList">;
  /** The Insights the user has not hidden from the feed (P03-R9), in the order given. */
  visibleInsights<T extends { id: number }>(insights: readonly T[]): T[];
  /** The preference weight of each Insight, −100..100 (P5F-R4); the lines of a target not shown count for nothing. */
  preferences(insights: readonly { id: number }[]): ReadonlyMap<number, number>;
  /** `feedback.learned`, the type step's switch (P5F-R5). */
  settings(): RouteResponse<"feedbackSettings">;
  writeSettings(request: RouteRequest<"setFeedbackSettings">): RouteResponse<"feedbackSettings">;
}

export function createFeedbackApi(
  db: SqlDriver,
  gate: ReadGate,
  decisions: () => FeedbackEntries | undefined,
  /** Called in the transaction of a correction, with the row it changed (conflict links, Insights and candidates follow). */
  afterCorrection: (ref: EntryRef, at: string) => void,
): FeedbackApi {
  /** The target is stored and shown now; a fact's or relation's items too, since its label names them. */
  const shown = (t: FeedbackTarget): boolean => {
    if (t.kind === "insight") return gate.insightEvidence(t.id) !== undefined;
    if (!gate.semanticShown(t.kind, t.id)) return false;
    return (
      t.kind === "item" ||
      itemsOfEntry(db, { kind: t.kind, id: t.id }).every((item) => gate.semanticShown("item", item))
    );
  };

  const nameOf = (item: number) =>
    (db.all("SELECT name FROM items WHERE id = ?", [item])[0]?.name as string | undefined) ?? "";
  const label = (t: FeedbackTarget, insightSummaries: ReadonlyMap<number, string>): string => {
    if (t.kind === "insight") return insightSummaries.get(t.id) ?? "";
    if (t.kind === "item") return nameOf(t.id);
    if (t.kind === "fact") {
      const f = db.all("SELECT item_id, kind, value FROM facts WHERE id = ?", [t.id])[0];
      return f ? `${nameOf(f.item_id as number)} · ${f.kind as string}: ${f.value as string}` : "";
    }
    const r = db.all("SELECT subject_id, type, object_id FROM relations WHERE id = ?", [t.id])[0];
    return r
      ? `${nameOf(r.subject_id as number)} ${r.type as string} ${nameOf(r.object_id as number)}`
      : "";
  };
  const line = (
    f: StoredFeedback,
    summaries: ReadonlyMap<number, string> = new Map(),
  ): FeedbackLine => ({
    id: f.id,
    kind: f.kind,
    class: feedbackClass(f.kind, f.target.kind) ?? "preference",
    target: f.target,
    label: label(f.target, summaries),
    at: f.createdAt,
  });
  const entryOf = (ref: EntryRef | null) => {
    const now = ref && readSemanticState(db, ref);
    return ref && now ? { entry: { ...ref, status: now.status, epistemic: now.epistemic } } : {};
  };

  const signalsOf = (insights: readonly { id: number }[]) => {
    const ids = new Set(insights.map((i) => i.id));
    const usable = (t: FeedbackTarget) => (t.kind === "insight" ? ids.has(t.id) : shown(t));
    return preferenceSignals(
      db,
      insights.map((i) => ({ kind: "insight", id: i.id }) as const),
      { usable },
    );
  };

  return {
    record(request, at) {
      const d = decisions();
      if (!d) return { error: "not-found" };
      return db.transaction((): Answer<"feedbackRecord"> => {
        const done = recordFeedback(db, d, request, at, { shown });
        if (done.status === "refused") {
          if (done.reason === "bad-request" || done.reason === "not-found") {
            return { error: done.reason };
          }
          return {
            status: "refused",
            reason: done.reason as RouteResponse<"feedbackRecord">["reason"],
            ...(done.unmet ? { unmet: [...gate.dataUnmetShown(request.target.id)] } : {}),
          };
        }
        if (done.touched) afterCorrection(done.touched, at);
        const summaries = new Map(gate.insights().map((i) => [i.id, i.summary]));
        return {
          status: "applied",
          feedback: line(done.feedback, summaries),
          ...entryOf(done.touched),
        };
      });
    },

    undo(request, at) {
      const d = decisions();
      if (!d) return { error: "not-found" };
      return db.transaction((): Answer<"feedbackUndo"> => {
        const done = undoFeedback(db, d, request.id, at, { shown });
        if (done.status === "refused") {
          return done.reason === "not-found"
            ? { error: "not-found" }
            : {
                status: "refused",
                reason: done.reason as RouteResponse<"feedbackUndo">["reason"],
              };
        }
        if (done.touched) afterCorrection(done.touched, at);
        return { status: "applied", ...entryOf(done.touched) };
      });
    },

    list() {
      const summaries = new Map(gate.insights().map((i) => [i.id, i.summary]));
      return {
        feedback: listFeedback(db, LIST_LIMIT, shown).map((f) => line(f, summaries)),
      };
    },

    visibleInsights(insights) {
      const signals = signalsOf(insights);
      return insights.filter((_, at) => !signals[at]?.hidden);
    },

    preferences(insights) {
      const signals = signalsOf(insights);
      return new Map(insights.map((insight, at) => [insight.id, signals[at]?.weight ?? 0]));
    },

    settings: () => ({ learned: feedbackLearned(db) }),

    writeSettings({ learned }) {
      writeSetting(db, FEEDBACK_LEARNED_SETTING, learned ? "on" : "off");
      return { learned: feedbackLearned(db) };
    },
  };
}
