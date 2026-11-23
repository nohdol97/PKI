// X01-R11: the Ask screen's view. Events fold into one state; the results draw the chosen route with the
// reasons, the hits (title, strategies, stale mark, related knowledge), the confirmed sentences with their
// quotes, the notices and the waiting indicator. Imported text (a title, a quote) reaches the page only as
// text, never as elements (V02-R15). The request is built from the form with empty filters left out.
import type { AskEvent } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api.ts";
import {
  applyEvent,
  AskResults,
  buildRequest,
  INITIAL_ASK,
  openCitation,
  type AskState,
} from "./ask.tsx";
import { SourceView } from "./evidence-view.tsx";

const route: AskEvent = {
  type: "route",
  route: {
    keyword: { status: "used" },
    graph: { status: "skipped" },
    wiki: { status: "off" },
    vector: { status: "unavailable", reason: "no-model" },
  },
};
const hits: AskEvent = {
  type: "hits",
  hits: [
    {
      versionId: 4,
      sourceId: 2,
      version: 1,
      rank: 1,
      title: '<img src="https://tracker.example.test/x"> 배포일 안내',
      strategies: ["keyword", "concept"],
      related: [
        { itemId: 9, name: "물결 프로젝트", wikiKey: "projects/9", wikiTitle: "물결 위키" },
      ],
    },
  ],
  notes: [
    { kind: "stale", versionId: 4 },
    { kind: "conflict", versionId: 4 },
  ],
};
const sentence: AskEvent = {
  type: "sentence",
  text: "배포일은 12월 10일입니다.",
  citation: {
    versionId: 4,
    sourceId: 2,
    version: 1,
    start: 7,
    end: 20,
    quote: "배포일은 12월 10일이다",
  },
};
const fold = (...list: AskEvent[]): AskState => list.reduce(applyEvent, INITIAL_ASK);
const html = (state: AskState, running = false) =>
  renderToStaticMarkup(<AskResults state={state} running={running} />);

describe("ask view: the results", () => {
  it("draws the route with the reason of an unavailable strategy, the hit with its strategies, stale and conflict marks and related knowledge", () => {
    const out = html(fold(route, hits));

    expect(out).toContain("벡터");
    expect(out).toContain("no-model");
    expect(out).toContain("낡음");
    expect(out).toContain("충돌");
    expect(out).toContain("키워드");
    expect(out).toContain("물결 프로젝트");
    expect(out).toContain("물결 위키");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("waits visibly between the hits and the answer, then shows each sentence with its quote and its source", () => {
    expect(html(fold(route, hits), true)).toContain("답을 만드는 중");

    const answered = fold(
      route,
      hits,
      { type: "answer", status: "started", reason: null },
      sentence,
      { type: "done", sentences: 1, dropped: 1, insufficient: false },
    );
    const out = html(answered);

    expect(out).not.toContain("답을 만드는 중");
    expect(out).toContain("배포일은 12월 10일입니다.");
    expect(out).toContain("배포일은 12월 10일이다");
    expect(out).toContain("&lt;img"); // the source's title, as text
    expect(out).toContain("확인하지 못해 버린 문장");
  });

  it("says the answer cannot be made, with the reason in words, and still shows the hits", () => {
    const out = html(
      fold(
        route,
        hits,
        { type: "answer", status: "blocked", reason: "no-provider" },
        {
          type: "done",
          sentences: 0,
          dropped: 0,
          insufficient: false,
        },
      ),
    );

    expect(out).toContain("답을 만들 수 없음");
    expect(out).toContain("기본 Provider가 정해지지 않음");
    expect(out).toContain("물결 프로젝트");
  });

  it("says when the evidence is not enough", () => {
    const out = html(
      fold(
        route,
        { type: "hits", hits: [], notes: [{ kind: "insufficient" }] },
        {
          type: "answer",
          status: "none",
          reason: "insufficient",
        },
      ),
    );

    expect(out).toContain("근거가 부족");
  });
});

describe("ask view: the request", () => {
  it("leaves out an empty filter and turns a day into the whole day in UTC", () => {
    expect(
      buildRequest({ question: " 배포일 ", answer: true, connectorId: "", from: "", to: "" }),
    ).toEqual({
      question: "배포일",
      answer: true,
    });
    expect(
      buildRequest({
        question: "배포일",
        answer: false,
        connectorId: "c1",
        from: "2026-11-01",
        to: "2026-11-30",
        acknowledgeUnverified: true,
      }),
    ).toEqual({
      question: "배포일",
      answer: false,
      connectorIds: ["c1"],
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-30T23:59:59.999Z",
      acknowledgeUnverified: true,
    });
  });
});

describe("ask view: a sentence's source (X02-C1a ②)", () => {
  it("reads the version by the citation's version number and marks the quoted span", async () => {
    const api = vi.fn(async () => ({
      sourceVersion: {
        id: 4,
        version: 1,
        latestVersion: 1,
        title: "배포 안내",
        body: "가나 배포일은 12월 10일이다 다라",
      },
    }));
    const citation = {
      versionId: 4,
      sourceId: 2,
      version: 1,
      start: 3,
      end: 17,
      quote: "배포일은 12월 10일이다",
    };
    const source = await openCitation(api as unknown as ApiClient, citation);
    expect(api).toHaveBeenCalledWith("exploreSource", { versionId: 4 });
    const out = renderToStaticMarkup(<SourceView source={source} />);
    expect(out).toContain("<mark>배포일은 12월 10일이다</mark>");
  });

  it("offers the source and the related knowledge as buttons, with no leftover pending note", () => {
    const answered = fold(
      route,
      hits,
      { type: "answer", status: "started", reason: null },
      sentence,
      { type: "done", sentences: 1, dropped: 0, insufficient: false },
    );
    const out = html(answered);
    expect(out).toContain("원본 보기");
    expect(out).not.toContain("다음 단계(X02)");
    expect(out).toMatch(/<button[^>]*>(<bdi>)?물결 프로젝트/);
  });
});
