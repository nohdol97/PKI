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
  sourceOpener,
  type AskState,
} from "./ask.tsx";
import { progressText, questionLimitText } from "./ask-text.ts";
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
  it("leaves out an empty filter and turns a day into a time range", () => {
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
      from: expect.any(String),
      to: expect.any(String),
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
      locator: null,
      attachment: null,
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
    expect(api).toHaveBeenCalledWith("exploreSource", { versionId: 4, start: 3 });
    const out = renderToStaticMarkup(<SourceView source={source} />);
    expect(out).toContain("<mark>배포일은 12월 10일이다</mark>");
  });

  it("shows the attachment name and the position the read answered for the cited start (X02B-C7 ②)", async () => {
    const api = vi.fn(async () => ({
      sourceVersion: { id: 4, version: 1, latestVersion: 1, title: "표", body: "가나다라" },
      locator: { format: "pdf", page: 3 },
      attachment: { name: "<b>계약서</b>.pdf", mediaType: "application/pdf", size: 2048 },
    }));
    const source = await openCitation(api as unknown as ApiClient, {
      versionId: 4,
      sourceId: 2,
      version: 1,
      start: 1,
      end: 3,
      quote: "나다",
    });
    const out = renderToStaticMarkup(<SourceView source={source} />);
    expect(out).toContain("3쪽");
    expect(out).toContain("&lt;b&gt;계약서");
    expect(out).toContain("application/pdf");
    expect(out).toContain("<mark>나다</mark>");
  });

  it("passes a refusal of the read on, so a hidden or deleted version shows as a failure and no source", async () => {
    const api = vi.fn(async () => {
      throw new Error("API 404: not-found");
    });
    await expect(
      openCitation(api as unknown as ApiClient, {
        versionId: 4,
        sourceId: 2,
        version: 1,
        start: 0,
        end: 1,
        quote: "가",
      }),
    ).rejects.toThrow("not-found");
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

  it("drops a source read that ends after a new question reset the opener, and shows one that did not (X02F-C7)", async () => {
    const answer = {
      sourceVersion: { id: 4, version: 1, latestVersion: 1, title: "t", body: "나다" },
      locator: null,
      attachment: null,
    };
    let finish: (value: unknown) => void = () => undefined;
    const api = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const shown: number[] = [];
    const failed: string[] = [];
    const opener = sourceOpener(
      api as unknown as ApiClient,
      (index) => shown.push(index),
      (text) => failed.push(text),
    );
    const citation = { versionId: 4, sourceId: 2, version: 1, start: 0, end: 1, quote: "나" };
    opener.open(citation, 0);
    opener.reset();
    finish(answer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).toEqual([]);
    opener.open(citation, 1);
    finish(answer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).toEqual([1]);
    // a failed read says the source could not be loaded, not that the question failed
    const broken = vi.fn(async () => {
      throw new Error("API 404");
    });
    const second = sourceOpener(
      broken as unknown as ApiClient,
      (index) => shown.push(index),
      (text) => failed.push(text),
    );
    second.open(citation, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).toEqual([1]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("원본");
    expect(failed[0]).toContain("API 404");
  });
});

// UI01-C10 (R6, R7, R10): the answer is flowing text whose sentence n ends with [n]; the quotes and their source
// lines are the cards of the list "인용한 원본", card n for sentence n; only an opened card holds the source view.
describe("ask view: the answer and the cited sources (UI01-C10)", () => {
  const second: AskEvent = {
    type: "sentence",
    text: "두 번째 문장입니다.",
    citation: {
      versionId: 4,
      sourceId: 2,
      version: 1,
      start: 30,
      end: 36,
      quote: "<b>둘째</b> 인용",
    },
  };
  const answered = fold(
    route,
    hits,
    { type: "answer", status: "started", reason: null },
    sentence,
    second,
    { type: "done", sentences: 2, dropped: 0, insufficient: false },
  );
  const render = (opened?: { index: number; source: Parameters<typeof SourceView>[0]["source"] }) =>
    renderToStaticMarkup(
      <AskResults
        state={answered}
        running={false}
        question="<i>배포일</i>이 언제야?"
        opened={opened}
      />,
    );
  const items = (out: string, name: string) => {
    const list = new RegExp(`<ol aria-label="${name}">([\\s\\S]*?)</ol>`).exec(out)?.[1] ?? "";
    return list.split(/<li[ >]/).slice(1);
  };

  it("shows the asked question as the title, as text", () => {
    const out = render();
    expect(out).toContain(
      '<h2 class="detail-title"><bdi>&lt;i&gt;배포일&lt;/i&gt;이 언제야?</bdi></h2>',
    );
  });

  it("ends sentence n with [n] and keeps the quotes out of the sentence list", () => {
    const sentences = items(render(), "답 문장");
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatch(/배포일은 12월 10일입니다\.[\s\S]*\[1\]<\/sup>\s*<\/li>/);
    expect(sentences[1]).toMatch(/\[2\]<\/sup>\s*<\/li>/);
    expect(sentences.join("")).not.toMatch(/12월 10일이다|둘째|<blockquote/);
  });

  it("draws card n of 인용한 원본 with [n], the quote, the source line and the button; the source view only in the opened card", () => {
    const plain = items(render(), "인용한 원본");
    expect(plain).toHaveLength(2);
    expect(plain[0]).toContain("[1]");
    expect(plain[0]).toContain("배포일은 12월 10일이다");
    expect(plain[0]).toContain("&lt;img"); // the source title, as text
    expect(plain[0]).toContain("(version 1, 위치 7–20)");
    expect(plain[0]).toMatch(/<button[^>]*>원본 보기<\/button>/);
    expect(plain[1]).toContain("&lt;b&gt;둘째&lt;/b&gt; 인용");
    expect(render()).not.toContain("인용 원본");
    const source = {
      evidenceId: 0,
      quote: "q",
      start: 0,
      end: 1,
      locator: null,
      attachment: null,
      sourceVersion: { id: 4, version: 1, latestVersion: 1, title: "t", body: "가나" },
    };
    const opened = items(render({ index: 1, source }), "인용한 원본");
    expect(opened[0]).not.toContain("인용 원본");
    expect(opened[1]).toContain('aria-label="인용 원본"');
  });
});

// CUF-C5 (R3): the chosen days are the user's local days, whatever the machine's time zone.
describe("ask view: the range is the user's days (CUF-C5)", () => {
  it("sends the local start of the first day and the local end of the last", () => {
    const req = buildRequest({
      question: "배포일",
      answer: true,
      connectorId: "",
      from: "2026-11-01",
      to: "2026-11-30",
    });
    const from = new Date(req.from as string);
    const to = new Date(req.to as string);
    expect([
      from.getFullYear(),
      from.getMonth(),
      from.getDate(),
      from.getHours(),
      from.getMinutes(),
    ]).toEqual([2026, 10, 1, 0, 0]);
    expect([
      to.getFullYear(),
      to.getMonth(),
      to.getDate(),
      to.getHours(),
      to.getMinutes(),
      to.getSeconds(),
    ]).toEqual([2026, 10, 30, 23, 59, 59]);
  });
});

// CUF-C6 (R4): a question over the limit is told, not cut.
describe("questionLimitText (CUF-C6)", () => {
  it("says the limit and the count for 2001 characters, and nothing for 2000", () => {
    const text = questionLimitText("가".repeat(2001));
    expect(text).toContain("2000");
    expect(text).toContain("2001");
    expect(questionLimitText("가".repeat(2000))).toBeNull();
    expect(questionLimitText(`  ${"가".repeat(2000)}  `)).toBeNull();
  });
});

// CUF-C7 (R5): the one always-present status line says the three steps the other paragraphs do not.
describe("progressText (CUF-C7)", () => {
  it("is empty before asking, then searching, the hit count, and the sentence count when done", () => {
    expect(progressText(INITIAL_ASK, false)).toBe("");
    expect(progressText(INITIAL_ASK, true)).toContain("찾는 중");
    const withHits = fold(route, hits);
    expect(progressText(withHits, true)).toContain("1건");
    const done = applyEvent(applyEvent(withHits, sentence), {
      type: "done",
      sentences: 1,
      dropped: 0,
      insufficient: false,
    });
    expect(progressText(done, false)).toContain("1문장");
  });
});
