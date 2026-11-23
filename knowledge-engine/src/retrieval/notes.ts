// X01-R6 and R7: the marks and the related-knowledge links of the hits, computed by code from the stored rows.
// Both read only what the registry shows for a search: a hit the policy hides takes part in no mark and no link.
import {
  entityGroups,
  factsEvidencedBy,
  isValidRow,
  itemsEvidencedBy,
  linksOfFacts,
  readItem,
  readStoredWikiPage,
  readVersionHeads,
  supersedingStands,
  type DerivativeRegistry,
  type DerivedRef,
  type SqlDriver,
} from "@pki/storage";
import { visibleLinks, type GraphJudge } from "../graph-read.ts";
import { WIKI_PAGE_KIND_NAME } from "../wiki-kind.ts";
import { pageKindOfType } from "../wiki-render.ts";
import { RELATED_LIMIT, type GapNote, type RelatedLink } from "./types.ts";

const key = (r: DerivedRef) => `${r.kind}:${r.id}`;
const sourceRef = (versionId: number): DerivedRef => ({ kind: "source", id: String(versionId) });

/** The hits' version row ids that the policy shows for a search. */
export function shownVersions(
  db: SqlDriver,
  registry: DerivativeRegistry,
  versionIds: readonly number[],
): Set<number> {
  return new Set(
    registry.visible(db, versionIds.map(sourceRef), "search").map((r) => Number(r.id)),
  );
}

/**
 * `stale`: a newer version of its source is shown for a search, or a fact resting on it was replaced by another fact
 * (a standing SUPERSEDES link). `conflict`: two facts resting on shown hits are tied by a CONTRADICTS link that
 * is still open, both facts valid and neither replaced. Only shown hits and shown links count.
 */
export function gapNotes(
  db: SqlDriver,
  registry: DerivativeRegistry,
  judge: GraphJudge,
  shown: readonly number[],
): GapNote[] {
  if (shown.length === 0) return [{ kind: "insufficient" }];
  const notes: GapNote[] = [];
  // a newer version the policy hides is no newer version for the caller (R12), so it makes nothing stale
  const heads = readVersionHeads(db, shown);
  const searchable = shownVersions(
    db,
    registry,
    heads.flatMap((h) => h.newerIds),
  );
  const stale = new Set(
    heads.filter((h) => h.newerIds.some((id) => searchable.has(id))).map((h) => h.id),
  );
  const resting = factsEvidencedBy(db, shown).filter((f) =>
    isValidRow(db, { kind: "fact", id: f.factId }, f.status),
  );
  const factIds = [...new Set(resting.map((f) => f.factId))];
  const links = visibleLinks(db, registry, judge, linksOfFacts(db, factIds));
  const replaced = new Set(links.filter((l) => supersedingStands(db, l)).map((l) => l.toFactId));
  const onHit = new Set(factIds);
  const conflicting = new Set(
    links
      .filter(
        (l) =>
          l.type === "CONTRADICTS" &&
          onHit.has(l.fromFactId) &&
          onHit.has(l.toFactId) &&
          !replaced.has(l.fromFactId) &&
          !replaced.has(l.toFactId),
      )
      .flatMap((l) => [l.fromFactId, l.toFactId]),
  );
  for (const f of resting) if (replaced.has(f.factId)) stale.add(f.versionId);
  const conflicted = new Set(
    resting.filter((f) => conflicting.has(f.factId)).map((f) => f.versionId),
  );
  for (const versionId of shown) {
    if (conflicted.has(versionId)) notes.push({ kind: "conflict", versionId });
    if (stale.has(versionId)) notes.push({ kind: "stale", versionId });
  }
  return notes;
}

/**
 * R7: per hit, the items its source supports (group representatives the policy shows, lowest id first, at most
 * RELATED_LIMIT) with each item's Wiki page when one is stored and shown.
 */
export function relatedLinks(
  db: SqlDriver,
  judge: GraphJudge,
  shown: readonly number[],
): Map<number, RelatedLink[]> {
  const representatives = new Map<number, number>();
  const rows = itemsEvidencedBy(db, shown).map(({ versionId, itemId }) => {
    const rep = representatives.get(itemId) ?? entityGroups.representativeOf(db, itemId);
    representatives.set(itemId, rep);
    return { versionId, itemId: rep };
  });
  rows.sort((a, b) => a.versionId - b.versionId || a.itemId - b.itemId);
  const itemRef = (id: number): DerivedRef => ({ kind: "item", id: String(id) });
  const items = [...new Set(rows.map((r) => r.itemId))];
  const itemOk = judge.shown(items.map(itemRef));
  const pages = new Map(
    items.flatMap((id) => {
      const type = readItem(db, id)?.type;
      if (type === undefined) return [];
      const pageKey = `${pageKindOfType(type)}/${id}`;
      const page = readStoredWikiPage(db, pageKey);
      return page ? [[id, { key: pageKey, title: page.title }] as const] : [];
    }),
  );
  const pageOk = judge.shown(
    [...pages.values()].map((p) => ({ kind: WIKI_PAGE_KIND_NAME, id: p.key })),
  );
  const out = new Map<number, RelatedLink[]>();
  for (const { versionId, itemId } of rows) {
    if (!itemOk.has(key(itemRef(itemId)))) continue;
    const list = out.get(versionId) ?? [];
    if (list.some((l) => l.itemId === itemId) || list.length >= RELATED_LIMIT) continue;
    const page = pages.get(itemId);
    const shownPage = page && pageOk.has(key({ kind: WIKI_PAGE_KIND_NAME, id: page.key }));
    list.push({
      itemId,
      name: readItem(db, itemId)?.name ?? "",
      wikiKey: shownPage ? page.key : null,
      wikiTitle: shownPage ? page.title : null,
    });
    out.set(versionId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.itemId - b.itemId);
  return out;
}
