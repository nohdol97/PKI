// The derivative kind `wiki-page` (K01-R8, K01-D3): layer projection, run in the canonical transaction. A
// page sits in the same file as the knowledge it was built from, so a source's deletion (or a prune of its
// earlier versions) reaches, in the transaction that deletes the source, every page whose lineage holds a
// version it takes. It runs after the canonical kinds, on the state they left, and writes each such page
// again from that state: a page no longer rendered (its target went with the source) is deleted with its
// lineage rows and outgoing links, a page another source also fed is rewritten with that source's claims
// only, so no letter of the deleted text stays and the page does not vanish (the spec's "deleted, rebuilt
// by the next build" is this, in one step; K01-R8 as written would leave the shared page for the next build,
// which the contract's case ② ("a row whose lineage keeps another source stays") rules out). The page's
// lineage is the one thing its scope, its egress class and its fence are judged by; nothing else is stored.
// A hide goes with its fact by the foreign key; a note is the user's own text and stays (K01-D7).
import {
  lineageOfWikiPage,
  removeWikiPage,
  writeWikiPage,
  type Affected,
  type DerivativeKind,
  type SourceChange,
  type SqlDriver,
} from "@pki/storage";
import { renderWikiPages } from "./wiki-render.ts";

export const WIKI_PAGE_KIND_NAME = "wiki-page";

/** Scope changes and new versions take nothing: the lineage stays, and the build is queued by the input sequence. */
const takes = (change: SourceChange): { below: number } | "all" | undefined => {
  if (change.kind === "new-version" || change.kind === "scope-changed") return undefined;
  if (change.kind === "old-versions-pruned") return { below: change.version };
  return "all";
};

export const WIKI_PAGE_KIND: DerivativeKind = {
  kind: WIKI_PAGE_KIND_NAME,
  layer: "projection",
  references: [],
  storage: "canonical",
  dataPaths: [],
  affected: (tx: SqlDriver, change: SourceChange): Affected => {
    const mode = takes(change);
    if (mode === undefined) return [];
    return tx
      .all(
        `SELECT DISTINCT page_key FROM wiki_page_lineage
          WHERE source_id = ? ${mode === "all" ? "" : "AND version < ?"} ORDER BY page_key`,
        mode === "all" ? [change.sourceId] : [change.sourceId, mode.below],
      )
      .map((r) => ({
        ref: { kind: WIKI_PAGE_KIND_NAME, id: r.page_key as string },
        lineage: lineageOfWikiPage(tx, r.page_key as string),
      }));
  },
  lineage: (db, ref) => lineageOfWikiPage(db, ref.id),
  invalidate: (ctx, snapshot) => {
    const { tx } = ctx;
    const keys = new Set(snapshot.map(({ ref }) => ref.id));
    const rendered = new Map(renderWikiPages(tx, keys).map((page) => [page.key, page]));
    const at = new Date().toISOString();
    let removed = 0;
    let recomputed = 0;
    for (const key of [...keys].sort()) {
      const page = rendered.get(key);
      if (page) {
        if (writeWikiPage(tx, page, at) !== "unchanged") recomputed++;
      } else if (removeWikiPage(tx, key, at)) {
        removed++;
      }
    }
    return { removed, recomputed };
  },
};
