// The `wiki-build` job (K01-R4, R5, R7, R10): reads the input sequence, renders every page, compares each
// page's hash with the stored one and hands back only the pages that changed and the pages of targets that
// are gone, plus the state advance as the last item. The runner writes the result through commitDerived in
// one transaction, so a write that throws leaves no half-written Wiki and no advance (the Wiki stays stale).
// No Provider is called. A forced rebuild skips the comparison and writes every page; a page whose hash is
// unchanged writes nothing, so its hash, its time and the log stay (writeWikiPage).
import {
  advanceWikiState,
  listStoredWikiPages,
  readWikiState,
  removeWikiPage,
  WIKI_PAGE_CAP,
  writeWikiPage,
  type DerivedItem,
  type SqlDriver,
} from "@pki/storage";
import { renderWikiPages } from "./wiki-render.ts";
import { WIKI_PAGE_KIND_NAME } from "./wiki-kind.ts";

export interface WikiBuildPlan {
  items: DerivedItem[];
  /** The input sequence the build was planned at: the pages are as of it. */
  inputSeq: number;
  /** Whether every page that differs is in `items`; false when the cap cut the run (the state does not advance). */
  complete: boolean;
}

/** What the handler hands the runner (a subset of backend job-outcomes.ts JobResult). */
export type WikiBuildResult = { status: "succeeded"; items: readonly DerivedItem[] };

export function planWikiBuild(
  db: SqlDriver,
  options: { at: string; force?: boolean; cap?: number },
): WikiBuildPlan {
  const state = readWikiState(db); // before any page is rendered: a change made while it runs stays ahead
  const force = options.force ?? state.forceSeq > state.forcedSeq;
  const cap = options.cap ?? WIKI_PAGE_CAP;
  const { at } = options;
  const rendered = renderWikiPages(db);
  const stored = new Map(listStoredWikiPages(db).map((p) => [p.key, p.contentHash]));
  const keys = new Set(rendered.map((p) => p.key));
  const gone = [...stored.keys()].filter((key) => !keys.has(key));
  const changed = rendered.filter((p) => force || stored.get(p.key) !== p.contentHash);
  const work: DerivedItem[] = [
    ...gone.map((key) => ({
      kind: WIKI_PAGE_KIND_NAME,
      itemKey: `gone:${key}`,
      lineage: [],
      write: (tx: SqlDriver) => void removeWikiPage(tx, key, at),
    })),
    ...changed.map((page) => ({
      kind: WIKI_PAGE_KIND_NAME,
      itemKey: `page:${page.key}`,
      lineage: page.lineage,
      write: (tx: SqlDriver) => void writeWikiPage(tx, page, at),
    })),
  ];
  const complete = work.length <= cap;
  const items = work.slice(0, cap);
  if (complete) {
    items.push({
      kind: WIKI_PAGE_KIND_NAME,
      itemKey: "state",
      lineage: [],
      write: (tx: SqlDriver) =>
        advanceWikiState(tx, { inputSeq: state.inputSeq, forcedSeq: state.forceSeq }),
    });
  }
  return { items, inputSeq: state.inputSeq, complete };
}

export interface WikiBuildOptions {
  db: SqlDriver;
  /** The write time of pages and log lines; default the wall clock. */
  now?: () => Date;
  /** Pages one run writes; default WIKI_PAGE_CAP. */
  cap?: number;
}

export function createWikiBuildHandler(options: WikiBuildOptions) {
  const now = options.now ?? (() => new Date());
  return async (): Promise<WikiBuildResult> => {
    const plan = planWikiBuild(options.db, {
      at: now().toISOString(),
      ...(options.cap === undefined ? {} : { cap: options.cap }),
    });
    return { status: "succeeded", items: plan.items };
  };
}
