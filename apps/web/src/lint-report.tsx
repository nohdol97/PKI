// The "놓친 것 알리기" form of the 점검 screen (CUF-R1, K02-R12): the user tells the lint what its rules missed.
// Only the three rules whose target is an item are offered; the user picks a rule, finds items by name and picks
// as many as that rule takes. The rule of how many is a plain function so it is tested without a DOM. Item names
// are imported text: they reach the page as React text nodes inside <bdi> only (V02-R15).
import type { RouteRequest } from "@pki/contracts";
import { type FormEvent, useState } from "react";
import type { ApiClient } from "./api.ts";
import { createBusy, createLatest } from "./latest.ts";
import {
  REPORT_APPLIED,
  REPORT_EXISTS,
  REPORT_HEADING,
  REPORT_HINT,
  REPORT_LOADING,
  REPORT_NONE,
  REPORT_NOT_FOUND,
  REPORT_PICKED,
  REPORT_RESULTS,
  REPORT_RULE,
  REPORT_SEARCH,
  REPORT_SEARCH_SUBMIT,
  REPORT_SUBMIT,
  reportFailedText,
  ruleText,
} from "./lint-text.ts";

type Report = RouteRequest<"lintReport">;
type Item = { id: number; name: string; type: string };
type Search = { status: "idle" | "loading" } | { status: "ready"; items: Item[] };

const REPORT_RULES = ["synonym", "missing-link", "overdue-work"] as const;
type ReportRule = (typeof REPORT_RULES)[number];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The request for the picked items, or `undefined` while their number does not fit the rule (the button's state). */
export function reportRequest(rule: string, ids: readonly number[]): Report | undefined {
  const [a, b] = ids;
  if (a === undefined) return undefined;
  if (rule === "overdue-work") return ids.length === 1 ? { rule, kind: "item", a } : undefined;
  if (rule !== "synonym" && rule !== "missing-link") return undefined;
  return ids.length === 2 && b !== undefined && a !== b ? { rule, kind: "item", a, b } : undefined;
}

export function LintReport({ api, onReported }: { api: ApiClient; onReported: () => void }) {
  const [rule, setRule] = useState<ReportRule>("synonym");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Search>({ status: "idle" });
  const [picked, setPicked] = useState<Item[]>([]);
  const [notice, setNotice] = useState<{ text: string; alert: boolean }>();
  const [latest] = useState(createLatest);
  const [busy] = useState(createBusy);

  const request = reportRequest(
    rule,
    picked.map((i) => i.id),
  );
  const find = (event: FormEvent) => {
    event.preventDefault();
    const current = latest.begin();
    setSearch({ status: "loading" });
    api("exploreItems", { query: query.trim() }).then(
      (page) => current() && setSearch({ status: "ready", items: page.items }),
      (error: unknown) => {
        if (!current()) return;
        setSearch({ status: "idle" });
        setNotice({ text: reportFailedText(message(error)), alert: true });
      },
    );
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!request) return;
    void busy(() =>
      api("lintReport", request).then(
        (r) => {
          setNotice({
            text:
              r.status === "applied"
                ? REPORT_APPLIED
                : r.status === "exists"
                  ? REPORT_EXISTS
                  : REPORT_NOT_FOUND,
            alert: false,
          });
          if (r.status === "applied") setPicked([]);
          if (r.status !== "not-found") onReported();
        },
        (error: unknown) => setNotice({ text: reportFailedText(message(error)), alert: true }),
      ),
    );
  };
  const pick = (item: Item) =>
    setPicked((p) => (p.some((i) => i.id === item.id) ? p : [...p, item]));
  return (
    <section aria-labelledby="lint-report-heading">
      <h3 id="lint-report-heading" className="group-label">
        {REPORT_HEADING}
      </h3>
      <p className="meta">{REPORT_HINT}</p>
      {notice && <p role={notice.alert ? "alert" : "status"}>{notice.text}</p>}
      <form onSubmit={send}>
        <label>
          {REPORT_RULE}{" "}
          <select
            aria-label={REPORT_RULE}
            value={rule}
            onChange={(e) => {
              setRule(e.target.value as ReportRule);
              setPicked([]);
            }}
          >
            {REPORT_RULES.map((r) => (
              <option key={r} value={r}>
                {ruleText(r)}
              </option>
            ))}
          </select>
        </label>{" "}
        <button type="submit" className="btn-primary" disabled={!request}>
          {REPORT_SUBMIT}
        </button>
      </form>
      <form onSubmit={find}>
        <label>
          {REPORT_SEARCH}{" "}
          <input
            aria-label={REPORT_SEARCH}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>{" "}
        <button type="submit">{REPORT_SEARCH_SUBMIT}</button>
      </form>
      {search.status === "loading" && <p role="status">{REPORT_LOADING}</p>}
      {search.status === "ready" && search.items.length === 0 && <p>{REPORT_NONE}</p>}
      {search.status === "ready" && search.items.length > 0 && (
        <ul className="plain-list" aria-label={REPORT_RESULTS}>
          {search.items.map((i) => (
            <li key={i.id}>
              <bdi>{i.name}</bdi> ({i.type}){" "}
              <button type="button" aria-label={`고르기: ${i.name}`} onClick={() => pick(i)}>
                고르기
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked.length > 0 && (
        <ul className="plain-list" aria-label={REPORT_PICKED}>
          {picked.map((i) => (
            <li key={i.id}>
              <bdi>{i.name}</bdi>{" "}
              <button
                type="button"
                aria-label={`빼기: ${i.name}`}
                onClick={() => setPicked((p) => p.filter((x) => x.id !== i.id))}
              >
                빼기
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
