// The 위키 screen (K01-R16): pages by kind, one page with its claims, evidence, links and
// backlinks, notes, hidden claims and change history. Every value comes from the backend;
// page titles, claim values and notes are imported or user-written text, so they reach the page
// as React text nodes inside <bdi> only (V02-R15). Evidence opens in the same source view Home uses.
import type { EvidenceSource, RouteRequest, RouteResponse, WikiClaim } from "@pki/contracts";
import { useCallback, useEffect, useState, type FormEvent, type Ref } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import { SOURCE_GONE } from "./evidence-text.ts";
import { SourceView, useFocusOn } from "./evidence-view.tsx";
import { useNav } from "./nav.tsx";
import { DetailPane, DETAIL_HINT, PaneHead, Row } from "./panes.tsx";
import {
  claimMarks,
  epistemicText,
  historyText,
  pageKindText,
  rebuildText,
  validityText,
  WIKI_BUILD_DEAD,
  WIKI_CLAIM_NO_EVIDENCE,
  WIKI_EMPTY,
  WIKI_NOT_FACT,
  WIKI_PAGE_GONE,
  WIKI_STALE,
  WIKI_SUMMARY_HELD,
  WIKI_SUMMARY_LABEL,
} from "./wiki-text.ts";

type Index = RouteResponse<"wiki">;
type Page = RouteResponse<"wikiPage">;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const gone = (error: unknown) => error instanceof ApiError && error.status === 404;
/** While a build is pending the screen reads again at this pace. */
const STALE_POLL_MS = 1_500;

function claimTitle(claim: WikiClaim, titleOf: (key: string) => string): string {
  return claim.to === undefined
    ? `${claim.kind}: ${claim.value ?? ""}`
    : `${claim.kind} → ${titleOf(claim.to)}`;
}

export interface PageViewProps {
  page: Page;
  source: EvidenceSource | undefined;
  headingRef: Ref<HTMLHeadingElement>;
  sourceHeadingRef: Ref<HTMLHeadingElement>;
  /** "n / N" among the listed pages, where the screen knows it. */
  position?: string | undefined;
  onOpenPage: (key: string) => void;
  onOpenEvidence: (evidenceId: number) => void;
  onHide: (claim: WikiClaim) => void;
  onUnhide: (claim: WikiClaim) => void;
  onAddNote: (text: string) => Promise<boolean>;
  onRemoveNote: (id: number) => void;
}

export function PageView(props: PageViewProps) {
  const { page, source, onOpenPage, onOpenEvidence } = props;
  const { hidden } = page;
  const [note, setNote] = useState("");
  const titleOf = (key: string) => page.links.find((l) => l.key === key)?.title ?? key;
  const addNote = (event: FormEvent) => {
    event.preventDefault();
    void props.onAddNote(note).then((added) => added && setNote(""));
  };
  const evidenceButtons = (ids: number[], what: string) =>
    ids.length === 0 ? (
      <span>{WIKI_CLAIM_NO_EVIDENCE}</span>
    ) : (
      ids.map((id, i) => (
        <button
          key={id}
          type="button"
          aria-label={`근거 보기 ${i + 1}: ${what}`}
          onClick={() => onOpenEvidence(id)}
        >
          근거 보기 {i + 1}
        </button>
      ))
    );
  return (
    <DetailPane
      label="페이지 상세"
      head={{ title: "페이지", count: props.position }}
      actions={
        <form className="actions" onSubmit={addNote}>
          <label>
            메모 쓰기
            <textarea maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit" className="btn-primary" disabled={note.trim() === ""}>
            메모 추가
          </button>
        </form>
      }
    >
      <h2 className="detail-title" id="wiki-page-heading" tabIndex={-1} ref={props.headingRef}>
        <bdi>{page.title}</bdi>
      </h2>
      <p>
        {pageKindText(page.kind)}
        {page.members.length > 1 && (
          <>
            {" · 같은 대상으로 묶인 이름: "}
            {page.members.map((m, i) => (
              <span key={m.id}>
                {i > 0 && ", "}
                <bdi>{m.name}</bdi>
              </span>
            ))}
          </>
        )}
      </p>
      <p>{WIKI_NOT_FACT}</p>
      {page.stale && <p role="status">{WIKI_STALE}</p>}
      {page.insight && (
        <>
          <p>
            <strong>{epistemicText(page.insight.epistemic)}</strong>{" "}
            <bdi>{page.insight.summary}</bdi>
          </p>
          <p>{evidenceButtons(page.insight.evidence, page.title)}</p>
        </>
      )}

      {page.summary.state === "ready" && (
        <section className="sec" aria-label={WIKI_SUMMARY_LABEL}>
          <h3>{WIKI_SUMMARY_LABEL}</h3>
          <ul>
            {page.summary.sentences?.map((s) => (
              <li key={`${s.sourceId}:${s.version}:${s.start}`}>
                <bdi>{s.text}</bdi>
              </li>
            ))}
          </ul>
        </section>
      )}
      {page.summary.state === "held" && <p role="status">{WIKI_SUMMARY_HELD}</p>}

      <div className="sec">
        <h3>주장</h3>
        {page.claims.length === 0 && <p>보여 줄 주장이 없습니다.</p>}
        {page.claims.length > 0 && (
          <ul className="plain-list" aria-label="주장">
            {page.claims.map((c) => {
              const title = claimTitle(c, titleOf);
              const validity = validityText(c);
              return (
                <li key={`${c.ref.kind}:${c.ref.id}`}>
                  <bdi>{title}</bdi> <strong>{claimMarks(c).join(" · ")}</strong>{" "}
                  {epistemicText(c.epistemic)}
                  {validity && ` · ${validity}`} {evidenceButtons(c.evidence, title)}
                  <button
                    type="button"
                    aria-label={`숨기기: ${title}`}
                    onClick={() => props.onHide(c)}
                  >
                    숨기기
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {hidden.length > 0 && (
        <div className="sec">
          <h3>숨긴 주장</h3>
          <ul className="plain-list" aria-label="숨긴 주장">
            {hidden.map((c) => {
              const title = claimTitle(c, titleOf);
              return (
                <li key={`${c.ref.kind}:${c.ref.id}`}>
                  <bdi>{title}</bdi>{" "}
                  <button
                    type="button"
                    aria-label={`다시 보이기: ${title}`}
                    onClick={() => props.onUnhide(c)}
                  >
                    다시 보이기
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {source && (
        <section className="sec" aria-labelledby="wiki-source-heading">
          <h3 id="wiki-source-heading" tabIndex={-1} ref={props.sourceHeadingRef}>
            원본 보기
          </h3>
          <SourceView source={source} />
        </section>
      )}

      <div className="sec">
        <h3>링크</h3>
        {page.links.length === 0 ? (
          <p>이 페이지가 가리키는 페이지가 없습니다.</p>
        ) : (
          <ul className="link-list" aria-label="링크">
            {page.links.map((l) => (
              <li key={l.key}>
                <button type="button" onClick={() => onOpenPage(l.key)}>
                  <bdi>{l.title}</bdi>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sec">
        <h3>이 페이지를 가리키는 페이지</h3>
        {page.backlinks.length === 0 ? (
          <p>이 페이지를 가리키는 페이지가 없습니다.</p>
        ) : (
          <ul className="link-list" aria-label="이 페이지를 가리키는 페이지">
            {page.backlinks.map((b) => (
              <li key={`${b.fromKey}:${b.basisKind}:${b.basisId}`}>
                <button type="button" onClick={() => onOpenPage(b.fromKey)}>
                  <bdi>{b.title}</bdi>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sec">
        <h3>메모</h3>
        {page.notes.length > 0 && (
          <ul className="plain-list" aria-label="메모">
            {page.notes.map((n) => (
              <li key={n.id}>
                <bdi>{n.text}</bdi> ({n.at}){" "}
                <button
                  type="button"
                  aria-label={`메모 지우기: ${n.text}`}
                  onClick={() => props.onRemoveNote(n.id)}
                >
                  지우기
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sec">
        <h3>변경 이력</h3>
        {page.history.length === 0 ? (
          <p>변경 이력이 없습니다.</p>
        ) : (
          <ol aria-label="변경 이력">
            {page.history.map((h) => (
              <li key={`${h.changeSeq}:${h.at}:${h.action}`}>{historyText(h)}</li>
            ))}
          </ol>
        )}
      </div>
    </DetailPane>
  );
}

/** `dead`: the last build gave up, so reading again cannot catch up and the screen says so instead of polling. */
export const buildState = (
  index: Pick<Index, "stale" | "buildDead"> | undefined,
  page: Pick<Page, "stale"> | undefined,
): "idle" | "building" | "dead" =>
  index?.buildDead === true
    ? "dead"
    : index?.stale === true || page?.stale === true
      ? "building"
      : "idle";

export function Wiki({ api }: { api: ApiClient }) {
  const [index, setIndex] = useState<Index>();
  const [page, setPage] = useState<Page>();
  const [source, setSource] = useState<EvidenceSource>();
  const [notice, setNotice] = useState<string>();
  const [rebuilding, setRebuilding] = useState<string>();
  const [opens, setOpens] = useState(0);
  const [sourceOpens, setSourceOpens] = useState(0);
  const headingRef = useFocusOn(opens, page !== undefined);
  const sourceHeadingRef = useFocusOn(sourceOpens, source !== undefined);
  const fail = (e: unknown) => setNotice(`불러오지 못했습니다: ${message(e)}`);

  const readIndex = useCallback(
    () =>
      api("wiki").then(setIndex, (e: unknown) => setNotice(`불러오지 못했습니다: ${message(e)}`)),
    [api],
  );
  /** Reads the page again; `fresh` is a page the user just opened (focus, and nothing carried over). */
  const readPage = useCallback(
    (key: string, fresh: boolean) =>
      api("wikiPage", { key }).then(
        (p) => {
          setPage(p);
          if (fresh) {
            setSource(undefined);
            setNotice(undefined);
            setOpens((n) => n + 1);
          }
        },
        (e: unknown) => {
          if (!gone(e)) return setNotice(`불러오지 못했습니다: ${message(e)}`);
          setPage(undefined);
          setSource(undefined);
          setNotice(WIKI_PAGE_GONE);
          void readIndex();
        },
      ),
    [api, readIndex],
  );

  useEffect(() => void readIndex(), [readIndex]);
  // another screen sent the user to a page (X02-R5)
  const wanted = useNav().target("wiki")?.wikiKey;
  useEffect(() => {
    if (wanted !== undefined) void readPage(wanted, true);
  }, [wanted, readPage]);
  const pageKey = page?.key;
  const state = buildState(index, page);
  const pending = state === "building";
  // a build runs in the background; the screen reads again until it has caught up
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      void readIndex();
      if (pageKey !== undefined) void readPage(pageKey, false);
    }, STALE_POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, index, page, pageKey, readIndex, readPage]);

  const edit = (request: RouteRequest<"wikiEdit">) =>
    api("wikiEdit", request).then(
      () => true,
      (e: unknown) => (fail(e), false),
    );
  const after = () => {
    if (pageKey !== undefined) void readPage(pageKey, false);
    void readIndex();
  };
  const openEvidence = (evidenceId: number) =>
    api("evidenceSource", { evidenceId }).then(
      (s) => {
        setSource(s);
        setSourceOpens((n) => n + 1);
      },
      (e: unknown) => (gone(e) ? setNotice(SOURCE_GONE) : fail(e)),
    );
  const rebuild = () =>
    api("wikiRebuild", {}).then((r) => {
      setRebuilding(rebuildText(r.status));
      void readIndex();
      if (pageKey !== undefined) void readPage(pageKey, false);
    }, fail);

  const listed = index?.kinds.flatMap((k) => k.pages) ?? [];
  const at = listed.findIndex((p) => p.key === pageKey);
  return (
    <>
      <div className="pane-list">
        <PaneHead title="위키" as="h1" count={listed.length}>
          <button type="button" onClick={() => void rebuild()}>
            다시 만들기
          </button>
        </PaneHead>
        <div className="pane-body">
          {notice && <p role="alert">{notice}</p>}
          {rebuilding && (
            <p>
              <span role="status">{rebuilding}</span>
            </p>
          )}
          {state === "dead" ? (
            <p role="alert">{WIKI_BUILD_DEAD}</p>
          ) : (
            index?.stale && <p role="status">{WIKI_STALE}</p>
          )}
          {index && index.kinds.length === 0 && <p>{WIKI_EMPTY}</p>}
          {index?.kinds.map((k) => (
            <section key={k.kind} aria-label={`${pageKindText(k.kind)} 종류`}>
              <h3 className="group-label">{pageKindText(k.kind)}</h3>
              <ul className="rows" aria-label={pageKindText(k.kind)}>
                {k.pages.map((p) => (
                  <li key={p.key}>
                    <Row
                      title={<bdi>{p.title}</bdi>}
                      selected={p.key === pageKey}
                      onClick={() => void readPage(p.key, true)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {index && index.orphanNotes.length > 0 && (
            <>
              <h3 className="group-label">붙을 페이지가 없는 메모</h3>
              <ul className="plain-list" aria-label="붙을 페이지가 없는 메모">
                {index.orphanNotes.map((n) => (
                  <li key={n.id}>
                    <bdi>{n.text}</bdi> ({n.at}){" "}
                    <button
                      type="button"
                      aria-label={`메모 지우기: ${n.text}`}
                      onClick={() =>
                        void edit({ op: "note-remove", id: n.id }).then(
                          (ok) => ok && void readIndex(),
                        )
                      }
                    >
                      지우기
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      {page ? (
        <PageView
          page={page}
          source={source}
          headingRef={headingRef}
          sourceHeadingRef={sourceHeadingRef}
          position={at >= 0 ? `${at + 1} / ${listed.length}` : undefined}
          onOpenPage={(key) => void readPage(key, true)}
          onOpenEvidence={(id) => void openEvidence(id)}
          onHide={(claim) =>
            void edit({ op: "hide", claim: claim.ref }).then((ok) => ok && after())
          }
          onUnhide={(claim) =>
            void edit({ op: "unhide", claim: claim.ref }).then((ok) => ok && after())
          }
          onAddNote={(text) =>
            edit({ op: "note-add", key: page.key, text }).then((ok) => (ok && after(), ok))
          }
          onRemoveNote={(id) => void edit({ op: "note-remove", id }).then((ok) => ok && after())}
        />
      ) : (
        <DetailPane label="페이지 상세" head={{ title: "페이지" }}>
          <p className="hint">{DETAIL_HINT}</p>
        </DetailPane>
      )}
    </>
  );
}
