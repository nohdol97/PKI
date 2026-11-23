// The ranking of an Insight (P01-R4): six axes of 0..100 and a fixed weighted sum, a pure function of the
// stored signals and the time. Urgency and novelty depend on "now", so nothing here is stored. The weights
// and bucket values are provisional constants, not measured on use (P01-D6). Relevance reads the user-input
// rows and, when the caller passes one, the feedback preference (P03-R8, D6).
import { insightType } from "@pki/contracts";

export interface RankingSignals {
  /** the Insight's type name (`insights.rule`) */
  type: string;
  confidence: number | null;
  /** YYYY-MM-DD */
  urgencyDate: string | null;
  changedAt: string | null;
  /** how many user-input rows the Insight used */
  userInputCount: number;
  /** An interpretation's 0..100 numbers (P01-R4, D12): when present they replace the type's defaults. */
  impact?: number | null;
  actionability?: number | null;
  /** The feedback preference weight, −100..100 (`preferenceSignals`); absent or 0 leaves relevance as it was (P03-R8). */
  preference?: number | null;
}

export interface InsightRanking {
  relevance: number;
  impact: number;
  urgency: number;
  novelty: number;
  confidence: number;
  actionability: number;
  score: number;
  /** The preference weight the relevance axis used, 0 when none, so a ranking can be explained (P03-R8). */
  preference: number;
}

export const RANK_WEIGHTS = {
  relevance: 0.15,
  impact: 0.25,
  urgency: 0.25,
  novelty: 0.1,
  confidence: 0.15,
  actionability: 0.1,
} as const;

const DAY_MS = 86_400_000;

/** The value of the first bucket whose limit (in days) holds `days`; `last` beyond all of them. */
const bucket = (days: number, limits: readonly (readonly [number, number])[], last: number) =>
  limits.find(([limit]) => days <= limit)?.[1] ?? last;

const clamp = (value: number) => Math.min(100, Math.max(0, value));

export function rankInsight(signals: RankingSignals, now: Date): InsightRanking {
  const info = insightType(signals.type);
  const until = signals.urgencyDate === null ? NaN : Date.parse(`${signals.urgencyDate}T00:00:00Z`);
  const since = signals.changedAt === null ? NaN : Date.parse(signals.changedAt);
  const preference = signals.preference ?? 0;
  const axes = {
    relevance: clamp(Math.round((signals.userInputCount > 0 ? 100 : 50) + preference / 2)),
    impact: signals.impact ?? info?.impact ?? 50,
    urgency: Number.isNaN(until)
      ? 30
      : bucket(
          (until - now.getTime()) / DAY_MS,
          [
            [7, 100],
            [30, 70],
            [90, 40],
          ],
          20,
        ),
    novelty: Number.isNaN(since)
      ? 10
      : bucket(
          (now.getTime() - since) / DAY_MS,
          [
            [1, 100],
            [7, 70],
            [30, 40],
          ],
          10,
        ),
    confidence: signals.confidence ?? 50,
    actionability: signals.actionability ?? info?.actionability ?? 50,
  };
  const score = Math.round(
    (Object.keys(RANK_WEIGHTS) as (keyof typeof RANK_WEIGHTS)[]).reduce(
      (sum, axis) => sum + RANK_WEIGHTS[axis] * axes[axis],
      0,
    ),
  );
  return { ...axes, score, preference };
}
