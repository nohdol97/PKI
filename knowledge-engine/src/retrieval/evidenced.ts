// RSP-R4, R5: the items a source version supports as a search may follow them. A row goes through a fact or a
// relation and ends at an item; it counts only when the policy shows both the fact or relation and the item.
// Related links (notes.ts) and the preference weight (preference.ts) both read here, so they cannot disagree.
import { itemsEvidencedBy, type DerivedRef, type SqlDriver } from "@pki/storage";
import type { GraphJudge } from "../graph-read.ts";

const ref = (kind: string, id: number): DerivedRef => ({ kind, id: String(id) });
const key = (r: DerivedRef) => `${r.kind}:${r.id}`;

/** The shown items each source version rests on through a shown fact or relation, one row per pair, in id order. */
export function shownItemsEvidencedBy(
  db: SqlDriver,
  judge: GraphJudge,
  versionIds: readonly number[],
): { versionId: number; itemId: number }[] {
  const rows = itemsEvidencedBy(db, versionIds);
  const via = (r: (typeof rows)[number]) =>
    r.factId !== null ? ref("fact", r.factId) : ref("relation", r.relationId as number);
  const viaOk = judge.shown(rows.map(via));
  const itemOk = judge.shown(rows.map((r) => ref("item", r.itemId)));
  const seen = new Set<string>();
  const pairs: { versionId: number; itemId: number }[] = [];
  for (const r of rows) {
    if (!viaOk.has(key(via(r))) || !itemOk.has(key(ref("item", r.itemId)))) continue;
    const pair = `${r.versionId}:${r.itemId}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    pairs.push({ versionId: r.versionId, itemId: r.itemId });
  }
  return pairs;
}
