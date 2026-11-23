// The derivative kind `lint-finding` (K02-R13, K02-D1): layer projection, run in the canonical transaction,
// like `wiki-page`: it runs after the canonical kinds, on the state they left. A finding names rows by id and
// holds no text, but its lineage still decides who may see it and what a deletion reaches. In the transaction
// that deletes a source (or prunes its earlier versions) every finding whose lineage holds a version it takes
// is judged again against what is left: one whose rule no longer finds it (its target went with the source)
// is deleted with its lineage rows, one that still stands is kept with the lineage it has now. The user's
// decision on a finding that stands is not undone by this. The dirty marks of the items the deletion took go in
// the same transaction (they name items by id).
import {
  findingIdsOfSource,
  lineageOfFinding,
  readFinding,
  removeFinding,
  replaceFindingLineage,
  entityGroups,
  fingerprintOf,
  type Affected,
  type DerivativeKind,
  type SourceChange,
  type SqlDriver,
} from "@pki/storage";
import { itemsOfFinding, lintFindings } from "./lint-rules.ts";

export const LINT_FINDING_KIND_NAME = "lint-finding";

/** Scope changes and new versions take nothing: the lineage is rewritten by the next run. */
const takes = (change: SourceChange): { below: number } | "all" | undefined => {
  if (change.kind === "new-version" || change.kind === "scope-changed") return undefined;
  if (change.kind === "old-versions-pruned") return { below: change.version };
  return "all";
};

export const LINT_FINDING_KIND: DerivativeKind = {
  kind: LINT_FINDING_KIND_NAME,
  layer: "projection",
  references: [],
  storage: "canonical",
  dataPaths: [],
  affected: (tx: SqlDriver, change: SourceChange): Affected => {
    const mode = takes(change);
    if (mode === undefined) return [];
    return findingIdsOfSource(tx, change.sourceId, mode === "all" ? undefined : mode.below).map(
      (id) => ({
        ref: { kind: LINT_FINDING_KIND_NAME, id: String(id) },
        lineage: lineageOfFinding(tx, id),
      }),
    );
  },
  lineage: (db, ref) => lineageOfFinding(db, Number(ref.id)),
  invalidate: ({ tx }, snapshot) => {
    const at = new Date().toISOString();
    let removed = 0;
    let recomputed = 0;
    // the dirty marks name items by id: one the deletion took has nothing left to look at
    tx.run("DELETE FROM reflection_dirty WHERE item_id NOT IN (SELECT id FROM items)");
    for (const { ref } of [...snapshot].sort((a, b) => Number(a.ref.id) - Number(b.ref.id))) {
      const finding = readFinding(tx, Number(ref.id));
      if (!finding) continue;
      const items = itemsOfFinding(tx, finding.target) ?? [];
      const groups = [...new Set(items.map((i) => entityGroups.representativeOf(tx, i)))];
      const again = lintFindings(tx, groups, at).find(
        (f) => fingerprintOf(f.rule, f.target) === finding.fingerprint,
      );
      if (!again) {
        if (removeFinding(tx, finding.id)) removed++;
      } else if (replaceFindingLineage(tx, finding.id, again.lineage)) {
        recomputed++;
      }
    }
    return { removed, recomputed };
  },
};
