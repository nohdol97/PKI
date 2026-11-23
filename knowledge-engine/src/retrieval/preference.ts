// X01-R19: the preference signal of R4 made from the user's item preferences (P03), read-only. A source version's
// weight comes from the items its evidence rests on (and their merge groups), and only from items and lines the
// read gate shows for a search (R12): a hidden item moves no hit.
import type { FeedbackTarget } from "@pki/contracts";
import {
  feedbackLearned,
  itemsEvidencedBy,
  preferenceSignals,
  withGroups,
  type DerivativeRegistry,
  type DerivedRef,
  type SqlDriver,
} from "@pki/storage";
import { createJudge } from "../graph-read.ts";
import { NO_PREFERENCE, type PreferenceSignal } from "./types.ts";

/** X01-D16: the weight is `1 + mean / PREFERENCE_SPAN`, the mean being of weights in −100..100, so 0.9..1.1. */
export const PREFERENCE_SPAN = 1000;

const itemRef = (id: number): DerivedRef => ({ kind: "item", id: String(id) });
const targetRef = (t: FeedbackTarget): DerivedRef => ({ kind: t.kind, id: String(t.id) });

/**
 * The signal of one request. Off (`feedback.learned` not `on`) is `NO_PREFERENCE` and reads nothing else. On, a
 * registry that cannot judge fails the request like R12 does. The mean runs over the items that have an opinion.
 */
export function feedbackPreference(db: SqlDriver, registry: DerivativeRegistry): PreferenceSignal {
  if (!feedbackLearned(db)) return NO_PREFERENCE;
  const judge = createJudge(db, registry, "search", false);
  const memo = new Map<number, number>();
  return {
    weight({ versionId }) {
      const known = memo.get(versionId);
      if (known !== undefined) return known;
      const items = [...new Set(itemsEvidencedBy(db, [versionId]).map((r) => r.itemId))];
      const shown = items.filter((id) => judge.shown([itemRef(id)]).size > 0);
      const members = withGroups(db, shown).map((id): FeedbackTarget => ({ kind: "item", id }));
      const opinions = preferenceSignals(db, members, {
        learned: false,
        usable: (t) => judge.shown([targetRef(t)]).size > 0,
      })
        .map((s) => s.weight)
        .filter((w) => w !== 0);
      const weight =
        opinions.length === 0
          ? 1
          : 1 + opinions.reduce((a, b) => a + b, 0) / opinions.length / PREFERENCE_SPAN;
      memo.set(versionId, weight);
      return weight;
    },
  };
}
