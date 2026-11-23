// X01-R3: the rank-reciprocal sum (RRF) of the strategies' lists, then the preference weight (R4), then the cut.
import {
  HIT_LIMIT,
  NO_PREFERENCE,
  RRF_K,
  type PreferenceSignal,
  type StrategyName,
} from "./types.ts";

/** Each id's sum of 1 / (K + rank) over the lists it is in (rank from 1). */
export function reciprocalSum(lists: readonly (readonly number[])[]): Map<number, number> {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  }
  return score;
}

/** The ids best first; equal scores go to the newer version row, so the order is the same every time. */
export const bestFirst = (score: ReadonlyMap<number, number>): number[] =>
  [...score.keys()].sort((a, b) => (score.get(b) as number) - (score.get(a) as number) || b - a);

export interface Merged {
  versionId: number;
  score: number;
  strategies: StrategyName[];
}

/**
 * Merges the lists by strategy (empty lists count for nothing), multiplies the preference weight in before cutting,
 * and keeps `HIT_LIMIT`. The weight only reorders: no id is added or removed by it.
 */
export function merge(
  lists: readonly { strategy: StrategyName; ids: readonly number[] }[],
  identify: (versionId: number) => { versionId: number; sourceId: number; version: number },
  preference: PreferenceSignal = NO_PREFERENCE,
): Merged[] {
  const score = reciprocalSum(lists.map((l) => l.ids));
  const weighted = new Map(
    [...score].map(([id, s]) => {
      const w = preference.weight(identify(id));
      return [id, s * (Number.isFinite(w) && w > 0 ? w : 1)];
    }),
  );
  return bestFirst(weighted)
    .slice(0, HIT_LIMIT)
    .map((versionId) => ({
      versionId,
      score: weighted.get(versionId) as number,
      strategies: lists.filter((l) => l.ids.includes(versionId)).map((l) => l.strategy),
    }));
}
