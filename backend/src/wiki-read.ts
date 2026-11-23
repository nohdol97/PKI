// The Wiki's read path and the user's edits (K01-R9, R11, R15). A page is stored without its scope: what
// leaves the backend is judged now, row by row, through the registry's `visible` and the read gate (I04-R13).
// The page itself is shown only while its target (the representative item, or the Insight) is stored and
// shown; otherwise it is the same answer as a key nothing is stored under. Inside a shown page a claim is shown
// only while its row is stored and shown (and its other end's page is), an evidence id likewise, a member's
// name likewise, a backlink only when the page it comes from and the row it rests on are. The user's edits are
// laid over at this read: a hidden claim is left out of `claims` and listed in `hidden` (judged by the same rules), the notes are attached (K01-R11).
import type { RouteRequest, RouteResponse } from "@pki/contracts";
import type { ClaimRef, WikiPageBody } from "@pki/knowledge-engine";
import {
  addWikiNote,
  effectiveUntil,
  isWikiStale,
  listStoredWikiPages,
  listWikiBacklinks,
  listWikiHidden,
  listWikiLog,
  listWikiNotes,
  readStoredWikiPage,
  removeWikiNote,
  setWikiHide,
  unionOfVersions,
  type DerivativeRegistry,
  type SqlDriver,
  type StoredWikiPage,
  type WikiLogLine,
} from "@pki/storage";
import type { ReadGate } from "./read-gate.ts";

type Index = RouteResponse<"wiki">;
type Page = RouteResponse<"wikiPage">;
type Edit = RouteRequest<"wikiEdit">;

/** Provisional: the latest change-log lines the index shows, and the lines one page's history keeps. */
const INDEX_LOG_LINES = 50;
const PAGE_HISTORY_LINES = 100;

/** A log line as the API gives it: no row id. */
const logLine = (l: WikiLogLine) => ({
  pageKey: l.pageKey,
  action: l.action,
  knowledgeRevision: l.knowledgeRevision,
  changeSeq: l.changeSeq,
  added: l.added,
  removed: l.removed,
  at: l.at,
});

export interface WikiReads {
  /** The index: the shown pages by kind, the latest log lines of shown pages, notes without a page. */
  index(): Index;
  /** undefined when no page is stored under the key or its target is not shown: the one answer for each. */
  page(key: string): Page | undefined;
  /** One of the four edits; `not-found` for a page, claim or note the caller may not see or that is not stored. */
  edit(request: Edit, at: string): { status: "applied" } | { error: "not-found" };
}

export function createWikiReads(
  db: SqlDriver,
  registry: DerivativeRegistry,
  gate: ReadGate,
): WikiReads {
  const visibleIds = (kind: string, ids: readonly number[]): Set<number> =>
    new Set(
      registry
        .visible(
          db,
          ids.map((id) => ({ kind, id: String(id) })),
          "display",
        )
        .map((ref) => Number(ref.id)),
    );
  /** The evidence ids that are stored and shown. */
  const shownEvidence = (ids: readonly number[]): Set<number> => {
    if (ids.length === 0) return new Set();
    const stored = new Set(
      db
        .all("SELECT id FROM evidence WHERE id IN (SELECT value FROM json_each(?))", [
          JSON.stringify(ids),
        ])
        .map((r) => r.id as number),
    );
    return visibleIds("evidence", [...stored]);
  };
  const insightShown = (id: number): boolean =>
    db.all("SELECT 1 FROM insights WHERE id = ? AND state = 'active'", [id]).length === 1 &&
    visibleIds("insight", [id]).has(id);
  const targetShown = (page: Pick<StoredWikiPage, "kind" | "target">): boolean =>
    page.kind === "syntheses"
      ? insightShown(Number(page.target))
      : gate.semanticShown("item", Number(page.target));
  /** The stored page under `key` when its target is shown. */
  const shownPage = (key: string): StoredWikiPage | undefined => {
    const stored = readStoredWikiPage(db, key);
    return stored && targetShown(stored) ? stored : undefined;
  };

  return {
    index() {
      const pages = listStoredWikiPages(db).filter(targetShown);
      const kinds = new Map<string, { key: string; title: string }[]>();
      for (const p of pages) {
        const list = kinds.get(p.kind) ?? [];
        list.push({ key: p.key, title: p.title });
        kinds.set(p.kind, list);
      }
      const shownKeys = new Set(pages.map((p) => p.key));
      const stored = new Set(db.all("SELECT key FROM wiki_pages").map((r) => r.key as string));
      return {
        stale: isWikiStale(db),
        kinds: [...kinds].map(([kind, list]) => ({ kind, pages: list })),
        log: listWikiLog(db, { limit: INDEX_LOG_LINES * 4 })
          .filter((l) => shownKeys.has(l.pageKey))
          .slice(0, INDEX_LOG_LINES)
          .map(logLine),
        orphanNotes: listWikiNotes(db)
          .filter((n) => !stored.has(n.pageKey))
          .map((n) => ({ id: n.id, pageKey: n.pageKey, text: n.text, at: n.at })),
      };
    },

    page(key) {
      const stored = shownPage(key);
      if (!stored) return undefined;
      const document = JSON.parse(stored.body) as WikiPageBody;
      const hiddenKeys = new Set(listWikiHidden(db).map((h) => `${h.kind}:${h.id}`));
      const isHidden = (c: { ref: { kind: string; id: number } }) =>
        hiddenKeys.has(`${c.ref.kind}:${c.ref.id}`);
      const claims = document.claims.filter((c) => !isHidden(c));
      // each row is stored and shown; a relation also needs the page at its other end to be shown
      const shownRows = {
        fact: new Set(claims.filter((c) => c.ref.kind === "fact").map((c) => c.ref.id)),
        relation: new Set(claims.filter((c) => c.ref.kind === "relation").map((c) => c.ref.id)),
      };
      for (const kind of ["fact", "relation"] as const) {
        for (const id of [...shownRows[kind]]) {
          if (!gate.semanticShown(kind, id)) shownRows[kind].delete(id);
        }
      }
      const evidenceOk = shownEvidence(document.claims.flatMap((c) => c.evidence));
      const keptRef = (r: { kind: "fact" | "relation"; id: number }) => shownRows[r.kind].has(r.id);
      // a link between two facts is shown only when the policy lets the two be put together (S02-R24)
      const together = new Map<string, boolean>();
      const combinable = (a: number, b: number): boolean => {
        const k = `${Math.min(a, b)}:${Math.max(a, b)}`;
        let ok = together.get(k);
        if (ok === undefined) {
          ok = registry.combinable(
            db,
            unionOfVersions(
              registry.lineage(db, { kind: "fact", id: String(a) }),
              registry.lineage(db, { kind: "fact", id: String(b) }),
            ),
          );
          together.set(k, ok);
        }
        return ok;
      };
      /** The claims of `list` whose row `own` lets through, each cut to what the caller may see. */
      const shape = (list: WikiPageBody["claims"], own: (r: ClaimRef) => boolean) =>
        list
          .filter((c) => own(c.ref))
          .filter((c) => c.to === undefined || shownPage(c.to) !== undefined)
          .map(({ supersededBy, ...c }) => ({
            ...c,
            // the end counts the superseders the caller may see, together with this fact, and no others
            validUntil: effectiveUntil(
              c.validUntil,
              supersededBy
                .filter(
                  (s) => gate.semanticShown("fact", s.ref.id) && combinable(c.ref.id, s.ref.id),
                )
                .map((s) => s.validAt),
            ),
            evidence: c.evidence.filter((id) => evidenceOk.has(id)),
            contradicts: c.contradicts.filter((r) => keptRef(r) && combinable(c.ref.id, r.id)),
            supersedes: c.supersedes.filter((r) => keptRef(r) && combinable(c.ref.id, r.id)),
          }));
      const kept = shape(claims, keptRef);
      const hidden = shape(document.claims.filter(isHidden), (r) =>
        gate.semanticShown(r.kind, r.id),
      );
      const toTitle = (toKey: string) => shownPage(toKey)?.title;
      const linkKeys = [
        ...new Set([
          ...kept.flatMap((c) => (c.to === undefined ? [] : [c.to])),
          ...(document.insight?.ends ?? []),
        ]),
      ].sort();
      const linkedPages = linkKeys.flatMap((k) => {
        const title = toTitle(k);
        return title === undefined ? [] : [{ key: k, title }];
      });
      const insightEvidence = shownEvidence(document.insight?.evidence ?? []);
      const backlinks = listWikiBacklinks(db, key).flatMap((l) => {
        const from = shownPage(l.fromKey);
        const rowShown =
          l.basisKind === "relation"
            ? gate.semanticShown("relation", l.basisId) && !hiddenKeys.has(`relation:${l.basisId}`)
            : true; // the Insight page that carries it was judged as `from`
        return from && rowShown
          ? [{ fromKey: l.fromKey, title: from.title, basisKind: l.basisKind, basisId: l.basisId }]
          : [];
      });
      return {
        key,
        kind: stored.kind,
        title: stored.title,
        stale: isWikiStale(db),
        members: document.members.filter((m) => gate.semanticShown("item", m.id)),
        claims: kept,
        hidden,
        links: linkedPages,
        backlinks,
        ...(document.insight
          ? {
              insight: {
                summary: document.insight.summary,
                epistemic: document.insight.epistemic,
                evidence: document.insight.evidence.filter((id) => insightEvidence.has(id)),
              },
            }
          : {}),
        notes: listWikiNotes(db, key).map((n) => ({ id: n.id, text: n.text, at: n.at })),
        history: listWikiLog(db, { pageKey: key, limit: PAGE_HISTORY_LINES })
          .reverse()
          .map(logLine),
        summary: { state: "off" },
      };
    },

    edit(request, at) {
      switch (request.op) {
        case "note-add":
          if (request.key === undefined || request.text === undefined || !shownPage(request.key)) {
            return { error: "not-found" };
          }
          addWikiNote(db, request.key, request.text, at);
          return { status: "applied" };
        case "note-remove": {
          const note = listWikiNotes(db).find((n) => n.id === request.id);
          // a note on a page that exists but is not shown is not the caller's to see
          const page = note && readStoredWikiPage(db, note.pageKey);
          if (!note || (page && !targetShown(page))) return { error: "not-found" };
          return removeWikiNote(db, note.id) ? { status: "applied" } : { error: "not-found" };
        }
        case "hide":
        case "unhide": {
          const { claim } = request;
          if (claim === undefined || !gate.semanticShown(claim.kind, claim.id)) {
            return { error: "not-found" };
          }
          setWikiHide(db, claim, request.op === "hide", at);
          return { status: "applied" };
        }
      }
    },
  };
}
