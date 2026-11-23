// The neighbour picture of the 탐색 screen (X02B-R9): the centre in the middle, each neighbour on a circle by its
// step count, the lines labelled with their relation type. Hand-placed SVG, no layout library, no drag or zoom
// (X02B-D5). Names and types are imported text, drawn as text nodes only. The picture is an image to a screen
// reader; the neighbour table beside it is the keyboard and screen-reader path, and clicking a name is a mouse
// convenience on top of it.
import { GRAPH_NOTE_CUT, graphSummary } from "./explore-text.ts";

/** The most neighbours drawn (provisional); the table lists them all. */
export const MAX_NODES = 60;
const RING = 90;

interface GraphItem {
  id: number;
  name: string;
}
interface GraphEdge {
  relationId: number;
  type: string;
  from: number;
  to: number;
  step: number;
}

/** The steps of the neighbours the shown lines reach, ascending by number, cut at `MAX_NODES`. */
export function placeNodes(centerId: number, edges: readonly GraphEdge[]) {
  const steps = new Map<number, number>();
  const reach = (id: number, step: number) => {
    if (id !== centerId) steps.set(id, Math.min(steps.get(id) ?? step, step));
  };
  for (const e of edges) {
    reach(e.to, e.step);
    if (!steps.has(e.from)) reach(e.from, Math.max(1, e.step - 1));
  }
  const ids = [...steps.keys()].sort((a, b) => a - b);
  const kept = ids.slice(0, MAX_NODES);
  const rings = new Map<number, number[]>();
  for (const id of kept) {
    const step = steps.get(id) as number;
    rings.set(step, [...(rings.get(step) ?? []), id]);
  }
  const points = new Map<number, { x: number; y: number }>([[centerId, { x: 0, y: 0 }]]);
  for (const [step, members] of rings)
    members.forEach((id, i) => {
      const angle = (2 * Math.PI * i) / members.length - Math.PI / 2 + step * 0.4;
      points.set(id, {
        x: Math.round(RING * step * Math.cos(angle)),
        y: Math.round(RING * step * Math.sin(angle)),
      });
    });
  return { points, cut: ids.length > kept.length, maxStep: Math.max(1, ...rings.keys()) };
}

export function NeighbourGraph({
  center,
  items,
  edges,
  off,
  onOpen,
}: {
  center: GraphItem;
  items: readonly GraphItem[];
  edges: readonly GraphEdge[];
  /** Relation types turned off: the same filter the table hears. */
  off: ReadonlySet<string>;
  onOpen: (itemId: number) => void;
}) {
  const shown = edges.filter((e) => !off.has(e.type));
  const { points, cut, maxStep } = placeNodes(center.id, shown);
  const drawn = shown.filter((e) => points.has(e.from) && points.has(e.to));
  const nameOf = (id: number) =>
    id === center.id ? center.name : (items.find((i) => i.id === id)?.name ?? `항목 ${id}`);
  const half = RING * maxStep + 80;
  return (
    <div className="graph">
      <svg
        role="img"
        aria-label={graphSummary(points.size, drawn.length)}
        viewBox={`${-half} ${-half} ${2 * half} ${2 * half}`}
        width="100%"
        height={Math.min(2 * half, 520)}
      >
        {drawn.map((e) => {
          const a = points.get(e.from) as { x: number; y: number };
          const b = points.get(e.to) as { x: number; y: number };
          return (
            <g key={e.relationId}>
              <line className="graph-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              <text
                className="graph-edge-label"
                x={(a.x + b.x) / 2}
                y={(a.y + b.y) / 2}
                textAnchor="middle"
              >
                {e.type}
              </text>
            </g>
          );
        })}
        {[...points].map(([id, p]) => (
          <g key={id} className="graph-node" onClick={() => onOpen(id)}>
            <circle
              className={id === center.id ? "graph-dot graph-dot-center" : "graph-dot"}
              cx={p.x}
              cy={p.y}
              r={id === center.id ? 10 : 6}
            />
            <text className="graph-name" x={p.x} y={p.y + 20} textAnchor="middle">
              {nameOf(id)}
            </text>
          </g>
        ))}
      </svg>
      {cut && <p role="status">{GRAPH_NOTE_CUT}</p>}
    </div>
  );
}
