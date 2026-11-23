// Linking to existing knowledge (V02-R7): before extraction, the items whose name
// the source's text holds literally become the candidates the Broker sends. The
// only processing before comparing is Unicode normalization (NFKC), one case and
// collapsed white space; no keyword index, ranking or similarity. Names are each
// item's one recorded name, and the item's `verified` surface forms (S01-R16, ADR 0021): a
// `candidate`, `disputed`, `rejected` or `superseded` form is not read, and a form the scope
// policy hides (its row or its item) is not read either.
import type { CandidateItems } from "@pki/providers";
import {
  findSourceVersionId,
  listItemNames,
  listVerifiedForms,
  normalizeForLinking,
  readItem,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";

export { normalizeForLinking };

/**
 * IDs of the items whose normalized name, or whose normalized `verified` form, the normalized text
 * contains, by id. Forms are read only with a registry (without one: names only, as before S01-T09).
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
  if (!registry) return [...found];
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
  return [...found].sort((a, b) => a - b);
}

const ROW_ID = /^[1-9][0-9]*$/;

/**
 * The Broker's candidate lookup on the knowledge store: an item's name and the
 * versions its name came from, all of them (past ones too), so the call is graded
 * with every source the name is text from. The sources are the registry's lineage of
 * the item (I04-R16): the one place that says where a derivative came from. An item
 * the registry cannot name the lineage of (the kind `item` is not registered) is an
 * error the Broker answers by refusing the request.
 */
export function knowledgeCandidates(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "lineage"> = derivativeRegistry,
): CandidateItems {
  return {
    lookup(id) {
      if (!ROW_ID.test(id)) return undefined;
      const item = readItem(db, Number(id));
      if (!item) return undefined;
      return {
        name: item.name,
        evidenceSourceVersionIds: registry
          .lineage(db, { kind: "item", id })
          // a version row the lineage names but the store lacks is an id the Broker cannot read: it refuses the call
          .map((v) => String(findSourceVersionId(db, v.sourceId, v.version) ?? 0)),
      };
    },
  };
}
