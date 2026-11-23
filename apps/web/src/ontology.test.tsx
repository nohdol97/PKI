// X02B-C6 (R11): the 유형 정의 screen against a fake API. Elements are grouped by kind, an action goes to the
// existing route and the list is read again, "미리 확인" shows the counts before an add is applied, and a
// refusal is shown as words. Imported names reach the page only as text.
import type { RouteName, RouteResponse } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api.ts";
import { EMPTY_DRAFT, changeOf, checkText, draftOf } from "./ontology-text.ts";
import { OntologyView, perform, preview } from "./ontology.tsx";

const elements: RouteResponse<"ontology">["elements"] = [
  {
    id: 1,
    elementKind: "item-type",
    name: "Project",
    rule: { elementKind: "item-type" },
    status: "verified",
    edition: 1,
    origin: "seed",
  },
  {
    id: 2,
    elementKind: "fact-kind",
    name: '<img src="https://tracker.example.test/x"> 마감',
    rule: {
      elementKind: "fact-kind",
      itemTypes: ["Project"],
      valueType: "date",
      cardinality: "one",
    },
    status: "candidate",
    edition: 1,
    origin: "source-proposed",
  },
  {
    id: 3,
    elementKind: "relation-type",
    name: "BLOCKS",
    rule: {
      elementKind: "relation-type",
      subjectTypes: ["Task"],
      objectTypes: ["Task"],
      symmetric: false,
    },
    status: "verified",
    edition: 2,
    origin: "user",
  },
];

function fake(handlers: Partial<Record<RouteName, (request: unknown) => unknown>>) {
  const calls: [string, unknown][] = [];
  const api = vi.fn(async (name: string, request?: unknown) => {
    calls.push([name, request]);
    const handler = handlers[name as RouteName];
    if (!handler) throw new Error(`unexpected route ${name}`);
    return handler(request);
  });
  return { api: api as unknown as ApiClient, calls };
}
const view = () =>
  renderToStaticMarkup(
    <OntologyView
      elements={elements}
      history={{}}
      onAct={() => undefined}
      onEdit={() => undefined}
      onHistory={() => undefined}
    />,
  );

describe("유형 정의 screen: the elements", () => {
  it("lists the elements under their kind with status, edition, origin and a rule summary, names as text, and a named button per action", () => {
    const out = view();
    for (const heading of ["항목 종류", "사실 종류", "관계 종류"]) expect(out).toContain(heading);
    expect(out).toContain("후보");
    expect(out).toContain("원본이 제안");
    expect(out).toContain("값 형식 date");
    expect(out).toContain("BLOCKS");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toMatch(/aria-label="승인: BLOCKS"/);
    expect(out).toMatch(/aria-label="이력: BLOCKS"/);
    expect(out).toMatch(/aria-label="물리기: BLOCKS"/);
  });

  it("approving a candidate calls ontologyDecide with its id and then reads the list again", async () => {
    const { api, calls } = fake({
      ontologyDecide: () => ({ status: "applied", id: 2, edition: 1, seq: 4 }),
      ontology: () => ({ elements }),
    });
    const done = await perform(api, { type: "decide", id: 2, action: "approve" });
    expect(calls).toEqual([
      ["ontologyDecide", { id: 2, action: "approve" }],
      ["ontology", undefined],
    ]);
    expect(done.refusal).toBeUndefined();
    expect(done.elements).toHaveLength(3);
  });
});

describe("유형 정의 screen: add and change", () => {
  const draft = { ...EMPTY_DRAFT, name: "담당자", itemTypes: "Project, Task", valueType: "text" };

  it("checks an added fact kind first, shows the counts, and applies it as op add", async () => {
    const check = {
      duplicates: 0,
      schemaErrors: [],
      impact: { liveRows: 5, violations: 2 },
      applicable: true,
    };
    const { api, calls } = fake({
      ontologyCheck: () => check,
      ontologyChange: () => ({ status: "applied", id: 9, edition: 1, seq: 7 }),
      ontology: () => ({ elements }),
    });
    expect(await preview(api, draft)).toEqual(check);
    expect(checkText(check)).toContain("남은 줄 5개");
    expect(checkText(check)).toContain("어긋남 2개");
    await perform(api, { type: "change", change: changeOf(draft) });
    expect(calls[0]).toEqual([
      "ontologyCheck",
      {
        op: "add",
        name: "담당자",
        rule: {
          elementKind: "fact-kind",
          itemTypes: ["Project", "Task"],
          valueType: "text",
          cardinality: "one",
        },
      },
    ]);
    expect(calls[1]?.[0]).toBe("ontologyChange");
    expect((calls[1]?.[1] as { op: string }).op).toBe("add");
  });

  it("says a duplicate refusal in words with its count, and sends a stored rule's dataChecks back unchanged", async () => {
    const { api } = fake({
      ontologyChange: () => ({
        status: "refused",
        reason: "duplicate",
        duplicates: 1,
        schemaErrors: [],
        impact: { liveRows: 0, violations: 0 },
      }),
      ontology: () => ({ elements }),
    });
    const done = await perform(api, { type: "change", change: changeOf(draft) });
    expect(done.refusal).toContain("같은 이름의 정의가 이미 있습니다");
    expect(done.refusal).toContain("겹치는 정의 1개");
    expect(done.refusal).not.toContain("duplicate");

    const kept = changeOf({ ...draft, mode: "change-rule", dataChecks: ["grain"] });
    expect(kept).toMatchObject({ op: "change-rule", elementKind: "fact-kind" });
    expect(kept.rule).toMatchObject({ dataChecks: ["grain"] });
  });
});

describe("유형 정의 screen: editing a stored rule", () => {
  it("opens the form with the stored rule and sends it back as a change-rule request with the same dataChecks", () => {
    const stored = {
      ...elements[1]!,
      rule: {
        elementKind: "fact-kind" as const,
        itemTypes: ["Project"],
        valueType: "date" as const,
        cardinality: "many" as const,
        dataChecks: ["schema" as const],
      },
    };
    expect(changeOf(draftOf(stored))).toEqual({
      op: "change-rule",
      name: stored.name,
      elementKind: "fact-kind",
      rule: stored.rule,
    });
  });
});
