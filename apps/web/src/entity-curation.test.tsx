// X02B-C3 (R7): the item-curation controls of the 탐색 screen against a fake API. Merge, unmerge, split and the
// distinct mark go to the existing routes with the numbers the screen holds; a refusal is shown as words, never
// as the bare code. (The press itself is the e2e's: these tests call the function a press calls.)
import type { RouteName } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api.ts";
import {
  EntityCuration,
  markDistinct,
  mergeInto,
  SplitResult,
  splitOff,
  unmerge,
} from "./entity-curation.tsx";
import type { Center } from "./explore.tsx";

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

const row = {
  status: "candidate",
  epistemic: "explicit",
  confidence: null,
  userDecided: false,
  userAuthored: false,
  evidenceCount: 1,
  validAt: null,
  validUntil: null,
} as const;
const center: Center = {
  id: 1,
  type: "Project",
  name: "미리내",
  wikiKey: null,
  members: [{ id: 9, type: "Project", name: "미리내 별칭 <b>", mergeId: 4 }],
  facts: [{ id: 5, kind: "memo", value: "메모", context: null, ...row }],
  relations: [{ id: 8, type: "OWNS", subjectId: 1, objectId: 2, ...row }],
};

describe("항목 정리 (X02B-C3)", () => {
  it("merges the chosen item into the centre by number; a refusal is shown in words", async () => {
    const { api, calls } = fake({ entityMerge: () => ({ status: "applied", mergeId: 4 }) });
    expect(await mergeInto(api, 9, 1)).toBeUndefined();
    expect(calls[0]).toEqual(["entityMerge", { member: 9, into: 1 }]);
    const refused = fake({ entityMerge: () => ({ status: "refused", reason: "type-mismatch" }) });
    const text = await mergeInto(refused.api, 9, 1);
    expect(text).toContain("종류");
    expect(text).not.toContain("type-mismatch");
  });

  it("unmerges by the member's mergeId and lists each member with its own named button", async () => {
    const { api, calls } = fake({ entityUnmerge: () => ({ status: "applied" }) });
    await unmerge(api, 4, true);
    expect(calls[0]).toEqual(["entityUnmerge", { mergeId: 4, keepDistinct: true }]);
    const out = renderToStaticMarkup(
      <EntityCuration
        api={api}
        center={center}
        onChanged={() => undefined}
        onOpen={() => undefined}
      />,
    );
    expect(out).toContain("합치기 되돌리기: 미리내 별칭 &lt;b&gt;");
    expect(out).not.toContain("<b>");
    expect(out).toContain("사실 memo 메모");
    expect(out).toContain("관계 OWNS 8");
  });

  it("splits the chosen rows under the new name and offers the created item", async () => {
    const { api, calls } = fake({ entitySplit: () => ({ status: "applied", created: 12 }) });
    const done = await splitOff(
      api,
      1,
      [
        { kind: "fact", id: 5 },
        { kind: "relation", id: 8 },
      ],
      "새 항목",
    );
    expect(calls[0]).toEqual([
      "entitySplit",
      {
        itemId: 1,
        rows: [
          { kind: "fact", id: 5 },
          { kind: "relation", id: 8 },
        ],
        name: "새 항목",
      },
    ]);
    expect(done).toEqual({ created: 12 });
    expect(renderToStaticMarkup(<SplitResult created={12} onOpen={() => undefined} />)).toContain(
      "만들어진 항목 열기",
    );
    const refused = fake({ entitySplit: () => ({ status: "refused", reason: "nothing-left" }) });
    expect(await splitOff(refused.api, 1, [{ kind: "fact", id: 5 }], "x")).toEqual({
      refusal: expect.stringContaining("남는 줄"),
    });
  });

  it("marks two items as different through entityDistinct and can clear the mark", async () => {
    const { api, calls } = fake({ entityDistinct: () => ({ status: "applied" }) });
    await markDistinct(api, 1, 9, true);
    await markDistinct(api, 1, 9, false);
    expect(calls).toEqual([
      ["entityDistinct", { a: 1, b: 9, on: true }],
      ["entityDistinct", { a: 1, b: 9, on: false }],
    ]);
  });
});
