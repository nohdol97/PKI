// X02B-C4 ③ (R9): the neighbour picture. Centre and neighbours are drawn by name, each line is labelled with its
// relation type, a type turned off takes its lines out, more than 60 neighbours are cut with a note, and the
// picture has an image role with a summary name (the table beside it stays the keyboard path).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MAX_NODES, NeighbourGraph } from "./neighbour-graph.tsx";

const center = { id: 1, name: "미리내" };
const items = [
  { id: 2, type: "System", name: "물결 API" },
  { id: 3, type: "System", name: "바다 API" },
  { id: 4, type: "System", name: "<i>파도</i>" },
];
const edges = [
  { relationId: 8, type: "DEPENDS_ON", direction: "forward" as const, from: 1, to: 2, step: 1 },
  { relationId: 9, type: "OWNS", direction: "backward" as const, from: 1, to: 3, step: 1 },
  { relationId: 10, type: "USES", direction: "forward" as const, from: 2, to: 4, step: 2 },
];
const draw = (over: Partial<Parameters<typeof NeighbourGraph>[0]> = {}) =>
  renderToStaticMarkup(
    <NeighbourGraph
      center={center}
      items={items}
      edges={edges}
      off={new Set()}
      onOpen={() => undefined}
      {...over}
    />,
  );

describe("이웃 그림 (X02B-C4 ③)", () => {
  it("draws the centre, three neighbours and three labelled lines in an image with a summary name", () => {
    const out = draw();
    for (const name of ["미리내", "물결 API", "바다 API", "&lt;i&gt;파도&lt;/i&gt;"])
      expect(out).toContain(name);
    expect(out).not.toContain("<i>");
    for (const type of ["DEPENDS_ON", "OWNS", "USES"]) expect(out).toContain(type);
    expect(out).toMatch(/<svg[^>]*role="img"/);
    expect(out).toContain('aria-label="이웃 그림: 항목 4개, 관계 3개"');
  });

  it("drops the lines of a relation type that is turned off, and says when it cuts at 60 neighbours", () => {
    const out = draw({ off: new Set(["OWNS"]) });
    expect(out).not.toContain("OWNS");
    expect(out).toContain("DEPENDS_ON");
    const many = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({
      id: 100 + i,
      type: "System",
      name: `이웃${i}`,
    }));
    const cut = draw({
      items: many,
      edges: many.map((m, i) => ({
        relationId: 500 + i,
        type: "T",
        direction: "forward" as const,
        from: 1,
        to: m.id,
        step: 1,
      })),
    });
    expect(cut).toContain("표에서 전부 볼 수 있습니다");
    expect(cut).toContain("이웃59");
    expect(cut).not.toContain("이웃60");
  });
});
