// X01-R19: the preference signal of R4 made from the user's item preferences (P03), read-only. A source version's
// weight comes from the items its evidence rests on (and their merge groups), and only from items and lines the
// read gate shows for a search (R12): a hidden item moves no hit.
import type { FeedbackTarget } from "@pki/contracts";
import {
  feedbackLearned,
  preferenceSignals,
  type DerivativeRegistry,
  type DerivedRef,
  type SqlDriver,
} from "@pki/storage";
import { createJudge, groupView } from "../graph-read.ts";
import { shownItemsEvidencedBy } from "./evidenced.ts";
import { NO_PREFERENCE, type PreferenceSignal } from "./types.ts";

/** X01-D16: the weight is `1 + mean / PREFERENCE_SPAN`, the mean being of weights in −100..100, so 0.9..1.1. */
export const PREFERENCE_SPAN = 1000;

const targetRef = (t: FeedbackTarget): DerivedRef => ({ kind: t.kind, id: String(t.id) });

/**
 * The signal of one request. Off (`feedback.learned` not `on`) is `NO_PREFERENCE` and reads nothing else. On, a
 * registry that cannot judge fails the request like R12 does. The mean runs over the items that have an opinion.
 */
export function feedbackPreference(db: SqlDriver, registry: DerivativeRegistry): PreferenceSignal {
  if (!feedbackLearned(db)) return NO_PREFERENCE;
  const judge = createJudge(db, registry, "search", false);
  const groups = groupView(db, judge);
  const memo = new Map<number, number>();
  return {
    weight({ versionId }) {
      const known = memo.get(versionId);
      if (known !== undefined) return known;
      const items = shownItemsEvidencedBy(db, judge, [versionId]).map((r) => r.itemId);
      const members = [
        ...new Set(items.flatMap((id) => groups.membersOfTop(groups.topOf(id)))),
      ].map((id): FeedbackTarget => ({ kind: "item", id }));
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
