// Linking to existing knowledge (V02-R7): before extraction, the items whose name
// the source's text holds literally become the candidates the Broker sends. The
// only processing before comparing is Unicode normalization (NFKC), one case and
// collapsed white space; no keyword index, ranking or similarity. Names are each
// item's one recorded name, and the item's `verified` surface forms (S01-R16, ADR 0021): a
// `candidate`, `disputed`, `rejected` or `superseded` form is not read, and a form the scope
// policy hides (its row or its item) is not read either. A match on any member of a merge group
// is the group's representative (S02-R13): the call offers the representative, never a member's
// name, and is graded and pre-filtered by the whole group's lineage.
import type { CandidateItems } from "@pki/providers";
import {
  entityGroups,
  findSourceVersionId,
  listItemNames,
  listVerifiedForms,
  normalizeForLinking,
  readInsightById,
  readItem,
  unionOfVersions,
  type DerivativeRegistry,
  type SourceVersionRef,
  type SqlDriver,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";

export { normalizeForLinking };

/**
 * IDs of the items whose normalized name, or whose normalized `verified` form, the normalized text
 * contains, each as its group's representative (a group counts once), by id. Forms are read only with a registry (without one: names only, as before S01-T09).
 * A form counts only when (1) the policy shows both its row and its item for a search
 * (`registry.visible`) and (2) its lineage lies inside its item's lineage: the extract handler's
 * combinable pre-filter and the Broker's grade read the item's lineage only, so a form from a source
 * the item's lineage lacks (an extracted form on a user-created item, whose lineage is empty, S01-R22)
 * would reach the call ungated. The form's text itself is never sent.
 */
export function findCandidates(
  db: SqlDriver,
  text: string,
  registry?: Pick<DerivativeRegistry, "visible" | "lineage">,
): number[] {
  const haystack = normalizeForLinking(text);
  const holds = (value: string) => {
    const needle = normalizeForLinking(value);
    return needle !== "" && haystack.includes(needle);
  };
  const found = new Set(
    listItemNames(db)
      .filter(({ name }) => holds(name))
      .map(({ id }) => id),
  );
  if (registry) addFormMatches(db, found, holds, registry);
  return [...new Set([...found].map((id) => entityGroups.representativeOf(db, id)))].sort(
    (a, b) => a - b,
  );
}

function addFormMatches(
  db: SqlDriver,
  found: Set<number>,
  holds: (value: string) => boolean,
  registry: Pick<DerivativeRegistry, "visible" | "lineage">,
): void {
  for (const { factId, itemId, form } of listVerifiedForms(db)) {
    if (found.has(itemId) || !holds(form)) continue;
    const fact = { kind: "fact", id: String(factId) };
    const item = { kind: "item", id: String(itemId) };
    const itemLineage = new Set(
      registry.lineage(db, item).map((v) => `${v.sourceId}@${v.version}`),
    );
    const inside = registry
      .lineage(db, fact)
      .every((v) => itemLineage.has(`${v.sourceId}@${v.version}`));
    if (inside && registry.visible(db, [fact, item], "search").length === 2) found.add(itemId);
  }
}

/** The source versions of every active member of the item's group, by the registry's lineage of each (R13, R6-3). */
export function groupLineage(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "lineage">,
  itemId: number,
): SourceVersionRef[] {
  return unionOfVersions(
    ...entityGroups
      .membersOf(db, itemId)
      .map((member) => registry.lineage(db, { kind: "item", id: String(member) })),
  );
}

const ROW_ID = /^[1-9][0-9]*$/;
/** An Insight offered as a candidate to its own interpretation (P01-D16). */
const INSIGHT_CANDIDATE = /^insight:([1-9][0-9]*)$/;

/**
 * The Broker's candidate lookup on the knowledge store: an item's name and the
 * versions its name came from, all of them (past ones too), so the call is graded
 * with every source the name is text from. The sources are the registry's lineage of
 * the item's whole group (I04-R16, S02-R13): the one place that says where a derivative came from. An item
 * the registry cannot name the lineage of (the kind `item` is not registered) is an
 * error the Broker answers by refusing the request.
 */
export function knowledgeCandidates(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "lineage"> = derivativeRegistry,
): CandidateItems {
  return {
    lookup(id) {
      const insightId = INSIGHT_CANDIDATE.exec(id)?.[1];
      if (insightId !== undefined) return insightCandidate(db, registry, id, Number(insightId));
      if (!ROW_ID.test(id)) return undefined;
      const item = readItem(db, Number(id));
      if (!item) return undefined;
      return {
        name: item.name,
        // the name sent is the representative's own text: no lineage of its own means no known origin, whatever its members' sources
        nameUnsourced: registry.lineage(db, { kind: "item", id }).length === 0,
        evidenceSourceVersionIds: groupLineage(db, registry, Number(id))
          // a version row the lineage names but the store lacks is an id the Broker cannot read: it refuses the call
          .map((v) => String(findSourceVersionId(db, v.sourceId, v.version) ?? 0)),
      };
    },
  };
}

/**
 * The source versions the text of an Insight candidate is graded by (P01-D16, D26): the Insight's own lineage and
 * the group lineage of its two items, because the text carries both items' names, as an item candidate is graded.
 */
export function insightGradingLineage(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "lineage">,
  insight: { id: number; xItemId: number; yItemId: number },
): SourceVersionRef[] {
  return unionOfVersions(
    registry.lineage(db, { kind: "insight", id: String(insight.id) }),
    groupLineage(db, registry, insight.xItemId),
    groupLineage(db, registry, insight.yItemId),
  );
}

/**
 * An active Insight as a candidate (P01-D16, D26): its name is the type, the summary and the fact lines, text the
 * code wrote from source values and item names, so it is graded by `insightGradingLineage`; one that used a row
 * of the user's own, or whose item has no lineage of its own (a user-made item), has a part with no source, which
 * makes it the strictest class (fail closed).
 */
function insightCandidate(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "lineage">,
  id: string,
  insightId: number,
) {
  const insight = readInsightById(db, insightId);
  if (insight?.state !== "active") return undefined;
  const itemUnsourced = [insight.xItemId, insight.yItemId].some(
    (item) => registry.lineage(db, { kind: "item", id: String(item) }).length === 0,
  );
  const versionIds = insightGradingLineage(db, registry, insight).map((v) =>
    findSourceVersionId(db, v.sourceId, v.version),
  );
  // a version the lineage names but the store lacks has no id to send: the candidate is not looked up at all
  if (versionIds.some((v) => v === undefined)) return undefined;
  return {
    name: `[${insight.rule}] ${insight.summary ?? ""} | ${insight.factLines.join(" | ")}`,
    nameUnsourced: insight.userInputs.length > 0 || itemUnsourced,
    evidenceSourceVersionIds: versionIds.map(String),
  };
}
