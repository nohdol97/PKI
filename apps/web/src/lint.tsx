// The 점검 screen (K02-R15): the findings of the lint by rule, each with its target rows, its evidence (opened
// in the source view the Wiki and Home use) and the user's decisions: accept (the existing entry runs),
// close, open again; a finding that stopped flip-flopping is marked "반복됨". Every value comes from the
// backend; row labels are imported or user-written text, so they reach the page as React text nodes inside
// <bdi> only (V02-R15).
import type { EvidenceSource, RouteResponse } from "@pki/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import { SOURCE_GONE } from "./evidence-text.ts";
import { SourceView, useFocusOn } from "./evidence-view.tsx";
import { DETAIL_HINT, DetailPane, PaneHead, Props, Row } from "./panes.tsx";
import {
  countsText,
  lastRunText,
  LINT_EMPTY,
  LINT_NO_EVIDENCE,
  LINT_NO_TYPES,
  LINT_NOT_FACT,
  LINT_OSCILLATING,
  opinionText,
  LINT_PICK_TYPE,
  LINT_RELATION_TYPE,
  refusalText,
  ruleHint,
  ruleText,
  statusText,
} from "./lint-text.ts";

type Lint = RouteResponse<"lint">;
type Finding = Lint["findings"][number];

const RULE_ORDER = ["synonym", "stale", "overdue-work", "missing-link"] as const;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const gone = (error: unknown) => error instanceof ApiError && error.status === 404;
/** The dot colour of a finding's status; the word beside it says the same (UI01-R7). */
const STATE_CLASS: Readonly<Record<string, string>> = {
  open: "state-attn",
  oscillating: "state-attn",
  accepted: "state-ok",
  resolved: "state-ok",
  dismissed: "state-none",
};
const heading = (f: Finding) => f.targets.map((t) => t.label).join(" ↔ ");

export function Lint({ api }: { api: ApiClient }) {
  const [lint, setLint] = useState<Lint>();
  const [source, setSource] = useState<EvidenceSource>();
  const [notice, setNotice] = useState<string>();
  const [types, setTypes] = useState<string[]>([]);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [sourceOpens, setSourceOpens] = useState(0);
  const [chosen, setChosen] = useState<number>();
  const sourceHeadingRef = useFocusOn(sourceOpens, source !== undefined);
  const fail = (e: unknown) => setNotice(`불러오지 못했습니다: ${message(e)}`);

  const read = useCallback(() => api("lint").then(setLint, fail), [api]);
  useEffect(() => void read(), [read]);
  // the relation types the user may choose: the verified ones of the type definitions
  useEffect(() => {
    void api("ontology").then(
      (o) =>
        setTypes(
          o.elements
            .filter((e) => e.elementKind === "relation-type" && e.status === "verified")
            .map((e) => e.name),
        ),
      () => undefined,
    );
  }, [api]);

  const decide = (f: Finding, op: "accept" | "dismiss" | "reopen") =>
    api("lintDecide", {
      id: f.id,
      op,
      ...(op === "accept" && f.rule === "missing-link" && picked[f.id]
        ? { relationType: picked[f.id] as string }
        : {}),
    }).then((r) => {
      setNotice(r.status === "applied" ? undefined : refusalText(r.reason));
      void read();
    }, fail);
  const openEvidence = (evidenceId: number) =>
    api("evidenceSource", { evidenceId }).then(
      (s) => {
        setSource(s);
        setSourceOpens((n) => n + 1);
      },
      (e: unknown) => (gone(e) ? setNotice(SOURCE_GONE) : fail(e)),
    );

  const findings = lint?.findings ?? [];
  const current = findings.find((f) => f.id === chosen);
  const at = current ? findings.indexOf(current) : -1;
  const stateOf = (f: Finding) => (
    <strong className={`state ${STATE_CLASS[f.status] ?? "state-none"}`}>
      {statusText(f.status)}
    </strong>
  );
  const open = current && (current.status === "open" || current.status === "oscillating");
  return (
    <>
      <div className="pane-list">
        <PaneHead title="점검" as="h1" count={lint ? findings.length : undefined} />
        <div className="pane-body">
          {notice && <p role="alert">{notice}</p>}
          <p>{LINT_NOT_FACT}</p>
          {lint && <p role="status">{lastRunText(lint.lastRun, lint.dirty)}</p>}
          {lint && lint.findings.length === 0 && <p>{LINT_EMPTY}</p>}
          {lint &&
            RULE_ORDER.map((rule) => {
              const mine = lint.findings.filter((f) => f.rule === rule);
              const counts = lint.counts.find((c) => c.rule === rule);
              return (
                <section key={rule} aria-label={`${ruleText(rule)} 종류`}>
                  <h3 className="group-label">{ruleText(rule)}</h3>
                  {counts && <p className="meta">{countsText(counts)}</p>}
                  <p className="meta">{ruleHint(rule)}</p>
                  {mine.length > 0 && (
                    <ul className="rows" aria-label={ruleText(rule)}>
                      {mine.map((f) => (
                        <li key={f.id}>
                          <Row
                            title={<bdi>{heading(f)}</bdi>}
                            meta={stateOf(f)}
                            selected={f.id === chosen}
                            onClick={() => (setChosen(f.id), setSource(undefined))}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
        </div>
      </div>
      {current ? (
        <DetailPane
          label="발견 상세"
          head={{ title: "발견", count: `${at + 1} / ${findings.length}` }}
          actions={
            <div className="actions" role="group" aria-label={`조치: ${heading(current)}`}>
              {open && current.rule === "missing-link" && (
                <label>
                  {LINT_RELATION_TYPE}
                  <select
                    aria-label={`${LINT_RELATION_TYPE}: ${heading(current)}`}
                    value={picked[current.id] ?? ""}
                    onChange={(e) => setPicked({ ...picked, [current.id]: e.target.value })}
                  >
                    <option value="">{types.length === 0 ? LINT_NO_TYPES : LINT_PICK_TYPE}</option>
                    {types.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {open && current.rule !== "overdue-work" && (
                <button
                  type="button"
                  className="btn-primary"
                  aria-label={`받아들이기: ${heading(current)}`}
                  disabled={current.rule === "missing-link" && !picked[current.id]}
                  onClick={() => void decide(current, "accept")}
                >
                  받아들이기
                </button>
              )}
              {open && (
                <button
                  type="button"
                  aria-label={`닫기: ${heading(current)}`}
                  onClick={() => void decide(current, "dismiss")}
                >
                  닫기
                </button>
              )}
              {current.status === "dismissed" && (
                <button
                  type="button"
                  aria-label={`다시 열기: ${heading(current)}`}
                  onClick={() => void decide(current, "reopen")}
                >
                  다시 열기
                </button>
              )}
            </div>
          }
        >
          <h3 className="detail-title">
            <bdi>{heading(current)}</bdi>
          </h3>
          <Props
            items={[
              ["종류", ruleText(current.rule)],
              ["상태", stateOf(current)],
            ]}
          />
          {current.status === "oscillating" && <p>{LINT_OSCILLATING}</p>}
          {current.opinion && <p>{opinionText(current.opinion)}</p>}
          <div className="sec">
            <h4>근거</h4>
            {current.evidence.length === 0 ? (
              <p>{LINT_NO_EVIDENCE}</p>
            ) : (
              <p className="row-actions">
                {current.evidence.map((id, i) => (
                  <button
                    key={id}
                    type="button"
                    aria-label={`근거 보기 ${i + 1}: ${heading(current)}`}
                    onClick={() => void openEvidence(id)}
                  >
                    근거 보기 {i + 1}
                  </button>
                ))}
              </p>
            )}
          </div>
          {source && (
            <section className="sec" aria-labelledby="lint-source-heading">
              <h3 id="lint-source-heading" tabIndex={-1} ref={sourceHeadingRef}>
                원본 보기
              </h3>
              <SourceView source={source} />
            </section>
          )}
        </DetailPane>
      ) : (
        <DetailPane label="발견 상세" head={{ title: "발견" }}>
          <p className="hint">{DETAIL_HINT}</p>
        </DetailPane>
      )}
    </>
  );
}
