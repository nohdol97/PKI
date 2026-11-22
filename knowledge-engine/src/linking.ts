// Linking to existing knowledge (V02-R7): before extraction, the items whose name
// the source's text holds literally become the candidates the Broker sends. The
// only processing before comparing is Unicode normalization (NFKC), one case and
// collapsed white space; no keyword index, ranking or similarity. Names are each
// item's one recorded name (aliases: V02 미해결 질문 6, provisional).
import type { CandidateItems } from "@pki/providers";
import {
  findSourceVersionId,
  listItemNames,
  readItem,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";

/** The comparison form of a name or a text. */
export const normalizeForLinking = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/** IDs of the items whose normalized name the normalized text contains, by id. */
export function findCandidates(db: SqlDriver, text: string): number[] {
  const haystack = normalizeForLinking(text);
  return listItemNames(db)
    .filter(({ name }) => {
      const needle = normalizeForLinking(name);
      return needle !== "" && haystack.includes(needle);
    })
    .map(({ id }) => id);
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
