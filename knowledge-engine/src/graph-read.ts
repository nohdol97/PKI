// The graph reads (S02-R21~R24, decision 31): the evidence chain behind an Insight, a fact or an item, and the relation
// paths from an item. Both are computed from the canonical rows when asked and nothing is stored. Every row a result
// names is judged by the registry's `visible` for the purpose, one by one (the edge), and then the lineage of the whole
// path or chain is asked of `combinable` (the sources that make it up must be allowed to be put together). A registry
// that cannot judge gives no path: inside these two reads a policy that throws is an empty answer, not an error.
import { GRAPH_MAX_DEPTH, type RouteResponse } from "@pki/contracts";
import {
  effectiveUntil,
  entityGroups,
  isValidRow,
  lineageOfItems,
  linksOfFacts,
  listEvidence,
  listInsightEvidenceIds,
  listInsightUserInputs,
  listSemanticFacts,
  listSemanticRelations,
  readFact,
  readItem,
  supersedingStands,
  unionOfVersions,
  validRow,
  type DerivativeRegistry,
  type DerivedRef,
  type KnowledgeStatus,
  type ScopePurpose,
  type SourceVersionRef,
  type SqlDriver,
  type StoredAssertionLink,
} from "@pki/storage";

/** S02-R22, decision 11: the items one path read expands, the start included. */
export const GRAPH_EXPANSION_LIMIT = 200;
/** Decision 31 (provisional): the paths and the chains one answer carries. */
export const GRAPH_PATH_LIMIT = 1000;
export const GRAPH_CHAIN_LIMIT = 500;

type TraceAnswer = RouteResponse<"graphTrace">;
type TraceHop = TraceAnswer["chains"][number][number];
type TraceNode = TraceHop["from"];
type PathHop = NonNullable<RouteResponse<"graphPaths">["paths"]>[number][number];

const key = (ref: DerivedRef) => `${ref.kind}:${ref.id}`;
const ref = (kind: string, id: number): DerivedRef => ({ kind, id: String(id) });

/** What a read needs from the registry: which rows are shown, and whether sources may be put together. */
export interface GraphJudge {
  shown(refs: readonly DerivedRef[]): ReadonlySet<string>;
  together(lineage: readonly SourceVersionRef[]): boolean;
}

/**
 * The judge of one read, each row judged once. `failClosed`: a policy that throws shows nothing and puts
 * nothing together (the graph reads); otherwise it throws through, and the caller's request fails (the lists).
 */
export function createJudge(
  db: SqlDriver,
  registry: DerivativeRegistry,
  purpose: ScopePurpose,
  failClosed: boolean,
): GraphJudge {
  const memo = new Map<string, boolean>();
  const guarded = <T>(run: () => T, otherwise: T): T => {
    if (!failClosed) return run();
    try {
      return run();
    } catch {
      return otherwise;
    }
  };
  return {
    shown(refs) {
      const fresh = [...new Map(refs.filter((r) => !memo.has(key(r))).map((r) => [key(r), r]))].map(
        ([, r]) => r,
      );
      if (fresh.length > 0) {
        const seen = new Set(guarded(() => registry.visible(db, fresh, purpose), []).map(key));
        for (const r of fresh) memo.set(key(r), seen.has(key(r)));
      }
      return new Set(refs.map(key).filter((k) => memo.get(k)));
    },
    together: (lineage) => guarded(() => registry.combinable(db, lineage), false),
  };
}

/** The links a read lists: the link shown, both its facts shown, its lineage combinable (S02-R24). */
export function visibleLinks(
  db: SqlDriver,
  registry: DerivativeRegistry,
  judge: GraphJudge,
  links: readonly StoredAssertionLink[],
): StoredAssertionLink[] {
  const linkOk = judge.shown(links.map((l) => ref("assertion-link", l.id)));
  const candidates = links.filter((l) => linkOk.has(key(ref("assertion-link", l.id))));
  const factOk = judge.shown(
    candidates.flatMap((l) => [ref("fact", l.fromFactId), ref("fact", l.toFactId)]),
  );
  return candidates.filter(
    (l) =>
      judge.together(registry.lineage(db, ref("assertion-link", l.id))) &&
      factOk.has(key(ref("fact", l.fromFactId))) &&
      factOk.has(key(ref("fact", l.toFactId))),
  );
}

/**
 * The merge groups as this read sees them (S02-R24 item 4): only what is shown counts. An item whose line
 * or upper item is not shown is a lone item here, and a line that rests is not followed.
 */
function groupView(db: SqlDriver, judge: GraphJudge) {
  const isShown = (r: DerivedRef) => judge.shown([r]).has(key(r));
  const topOf = (item: number): number => {
    const seen = new Set([item]);
    let at = item;
    for (;;) {
      const line = db.all(
        "SELECT id, representative_id FROM item_merges WHERE member_id = ? AND active = 1",
        [at],
      )[0];
      if (!line) return at;
      const up = line.representative_id as number;
      if (
        seen.has(up) ||
        !isShown({ kind: "entity-merge", id: `merge:${line.id}` }) ||
        !isShown(ref("item", up))
      ) {
        return at;
      }
      seen.add(up);
      at = up;
    }
  };
  const membersOfTop = (top: number): number[] =>
    entityGroups
      .membersOf(db, top)
      .filter((m) => topOf(m) === top && (m === top || isShown(ref("item", m))));
  const lineages = new Map<number, SourceVersionRef[]>();
  const groupLineage = (top: number): SourceVersionRef[] => {
    const known = lineages.get(top);
    if (known) return known;
    const members = membersOfTop(top);
    const read = members.length > 1 ? lineageOfItems(db, members) : [];
    lineages.set(top, read);
    return read;
  };
  return { topOf, membersOfTop, groupLineage };
}

export interface PathQuery {
  from: number;
  to?: number | undefined;
  depth: number;
}

interface Walk {
  tops: number[];
  hops: PathHop[];
}

/**
 * The relation paths from an item, up to `depth` (at most GRAPH_MAX_DEPTH) relations long (S02-R22). A deeper ask is
 * refused before the store is read. undefined: an end is absent or not shown. Paths run between group
 * representatives, never through the same one twice, and are ordered by length, then the items passed, then the relations.
 */
export function relationPaths(
  db: SqlDriver,
  registry: DerivativeRegistry,
  query: PathQuery,
  purpose: ScopePurpose,
):
  | { status: "ok"; paths: PathHop[][]; truncated: boolean }
  | { status: "refused"; reason: "depth-exceeded" }
  | undefined {
  if (query.depth > GRAPH_MAX_DEPTH) return { status: "refused", reason: "depth-exceeded" };
  const judge = createJudge(db, registry, purpose, true);
  const view = groupView(db, judge);
  const itemShown = (id: number) =>
    readItem(db, id) !== undefined && judge.shown([ref("item", id)]).has(key(ref("item", id)));
  if (!itemShown(query.from) || (query.to !== undefined && !itemShown(query.to))) return undefined;
  const start = view.topOf(query.from);
  const target = query.to === undefined ? undefined : view.topOf(query.to);
  if (target === start) return { status: "ok", paths: [], truncated: false };

  const relationLineage = new Map<number, SourceVersionRef[]>();
  const lineageOf = (id: number) => {
    const known = relationLineage.get(id);
    if (known) return known;
    const read = registry.lineage(db, ref("relation", id));
    relationLineage.set(id, read);
    return read;
  };
  /** The whole path's sources, with the visible members' of every group it passes through. */
  const together = (walk: Walk) =>
    judge.together(
      unionOfVersions(
        ...walk.hops.map((h) => lineageOf(h.relationId)),
        ...walk.tops.map((t) => view.groupLineage(t)),
      ),
    );

  const expanded = new Set([start]);
  let truncated = false;
  let reached: Walk[] = [{ tops: [start], hops: [] }];
  const kept: Walk[] = [];
  for (let level = 1; level <= query.depth && reached.length > 0; level++) {
    const frontier = [...new Set(reached.map((w) => w.tops.at(-1) as number))];
    const members = JSON.stringify(frontier.flatMap((t) => view.membersOfTop(t)));
    const rows = db
      .all(
        `SELECT id, subject_id, type, object_id, status FROM relations
         WHERE subject_id IN (SELECT value FROM json_each(?)) OR object_id IN (SELECT value FROM json_each(?))
         ORDER BY id`,
        [members, members],
      )
      .filter((r) =>
        isValidRow(db, { kind: "relation", id: r.id as number }, r.status as KnowledgeStatus),
      );
    const ok = judge.shown(
      rows.flatMap((r) => [
        ref("relation", r.id as number),
        ref("item", r.subject_id as number),
        ref("item", r.object_id as number),
      ]),
    );
    const edges = rows
      .filter(
        (r) =>
          ok.has(key(ref("relation", r.id as number))) &&
          ok.has(key(ref("item", r.subject_id as number))) &&
          ok.has(key(ref("item", r.object_id as number))),
      )
      .map((r) => ({
        id: r.id as number,
        type: r.type as string,
        subject: view.topOf(r.subject_id as number),
        object: view.topOf(r.object_id as number),
      }))
      .filter((e) => e.subject !== e.object);
    // the items reached over shown edges, lowest number first, up to the limit (R24 item 5: only shown edges are counted)
    const open = new Set(frontier);
    const arriving = [
      ...new Set(
        edges.flatMap((e) => [
          ...(open.has(e.subject) ? [e.object] : []),
          ...(open.has(e.object) ? [e.subject] : []),
        ]),
      ),
    ]
      .filter((t) => !expanded.has(t))
      .sort((a, b) => a - b);
    for (const top of arriving) {
      if (expanded.size >= GRAPH_EXPANSION_LIMIT) {
        truncated = true;
        break;
      }
      expanded.add(top);
    }
    const next: Walk[] = [];
    for (const walk of reached) {
      const at = walk.tops.at(-1) as number;
      for (const e of edges) {
        const forward = e.subject === at;
        if (!forward && e.object !== at) continue;
        const to = forward ? e.object : e.subject;
        if (!expanded.has(to) || walk.tops.includes(to)) continue;
        const extended: Walk = {
          tops: [...walk.tops, to],
          hops: [
            ...walk.hops,
            {
              relationId: e.id,
              type: e.type,
              direction: forward ? "forward" : "backward",
              from: at,
              to,
            },
          ],
        };
        if (together(extended)) next.push(extended);
      }
    }
    kept.push(...next);
    reached = next;
    // paths are cut shortest first, so once the matching ones pass the cap no deeper level can be shown
    if (
      kept.filter((w) => target === undefined || w.tops.at(-1) === target).length > GRAPH_PATH_LIMIT
    )
      break;
  }
  const order = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
    }
    return a.length - b.length;
  };
  const paths = kept
    .filter((w) => target === undefined || w.tops.at(-1) === target)
    .sort(
      (a, b) =>
        a.hops.length - b.hops.length ||
        order(a.tops, b.tops) ||
        order(
          a.hops.map((h) => h.relationId),
          b.hops.map((h) => h.relationId),
        ),
    );
  return {
    status: "ok",
    paths: paths.slice(0, GRAPH_PATH_LIMIT).map((w) => w.hops),
    truncated: truncated || paths.length > GRAPH_PATH_LIMIT,
  };
}

export interface TraceStart {
  kind: "insight" | "fact" | "item";
  id: number;
}

/** One chain being built: its hops, and every row it rests on (each must be shown, their lineage combinable). */
interface Chain {
  hops: TraceHop[];
  rows: DerivedRef[];
  lineage: SourceVersionRef[];
}
const chainOf = (
  hops: TraceHop[],
  rows: DerivedRef[],
  lineage: SourceVersionRef[] = [],
): Chain => ({
  hops,
  rows,
  lineage,
});

/**
 * The evidence chains of an Insight, a fact or an item (S02-R21): each runs from the start through the rows it
 * stands on to the source version and the span. A chain with a row that is not shown, or whose sources the policy
 * will not put together, is not given. undefined: the start is absent, not active (an Insight) or not shown.
 */
export function traceChains(
  db: SqlDriver,
  registry: DerivativeRegistry,
  start: TraceStart,
  purpose: ScopePurpose,
): TraceAnswer | undefined {
  const judge = createJudge(db, registry, purpose, true);
  const view = groupView(db, judge);
  const startRef = ref(start.kind, start.id);
  const exists =
    start.kind === "insight"
      ? db.all("SELECT 1 AS one FROM insights WHERE id = ? AND state = 'active'", [start.id])
          .length > 0
      : start.kind === "fact"
        ? readFact(db, start.id) !== undefined
        : readItem(db, start.id) !== undefined;
  if (!exists || !judge.shown([startRef]).has(key(startRef))) return undefined;

  const effectiveEnd = new Map<number, string | null>();
  const endOf = (factId: number): string | null => {
    const known = effectiveEnd.get(factId);
    if (known !== undefined) return known;
    const own = readFact(db, factId);
    const superseders = visibleLinks(db, registry, judge, linksOfFacts(db, [factId])).filter(
      (l) => l.toFactId === factId && supersedingStands(db, l),
    );
    const end = effectiveUntil(
      own?.validUntil ?? null,
      superseders.map((l) => readFact(db, l.fromFactId)?.validAt ?? null),
    );
    effectiveEnd.set(factId, end);
    return end;
  };
  const node = (kind: "fact" | "relation", id: number): TraceNode =>
    kind === "fact" ? { kind, id, effectiveUntil: endOf(id) } : { kind, id };
  const rowRef = (kind: "fact" | "relation", id: number) => ref(kind, id);

  /** From a fact or relation to the source spans it cites (`only`: one evidence row), and to the user when the user wrote it. */
  const tail = (kind: "fact" | "relation", id: number, only?: number): Chain[] => {
    const target = kind === "fact" ? { factId: id } : { relationId: id };
    const out: Chain[] = listEvidence(db, target)
      .filter((e) => only === undefined || e.id === only)
      .map((e) => {
        const span: TraceNode = { kind: "evidence", id: e.id, start: e.start, end: e.end };
        return chainOf(
          [
            { edge: "SUPPORTS", from: node(kind, id), to: span },
            { edge: "MENTIONS", from: span, to: { kind: "source-version", id: e.sourceVersionId } },
          ],
          [rowRef(kind, id), ref("evidence", e.id)],
        );
      });
    if (only === undefined && validRow(db, { kind, id })?.input) {
      out.push(
        chainOf(
          [{ edge: "SUPPORTS", from: node(kind, id), to: { kind: "user-input" } }],
          [rowRef(kind, id)],
        ),
      );
    }
    return out;
  };
  const extend = (prefix: Chain, tails: Chain[]): Chain[] =>
    tails.length === 0
      ? [prefix]
      : tails.map((t) =>
          chainOf([...prefix.hops, ...t.hops], [...prefix.rows, ...t.rows], prefix.lineage),
        );

  const built: Chain[] = [];
  if (start.kind === "fact") {
    built.push(...tail("fact", start.id));
    for (const l of visibleLinks(db, registry, judge, linksOfFacts(db, [start.id]))) {
      const forward = l.fromFactId === start.id;
      const other = forward ? l.toFactId : l.fromFactId;
      const hop: TraceHop = {
        edge: l.type,
        from: node("fact", start.id),
        to: node("fact", other),
        linkId: l.id,
        direction: forward ? "forward" : "backward",
      };
      built.push(
        ...extend(
          chainOf([hop], [ref("fact", start.id), ref("assertion-link", l.id)]),
          tail("fact", other),
        ),
      );
    }
  } else if (start.kind === "insight") {
    const insight: TraceNode = { kind: "insight", id: start.id };
    const cited = listInsightEvidenceIds(db, start.id);
    const rows = db.all(
      "SELECT id, fact_id, relation_id FROM evidence WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
      [JSON.stringify(cited)],
    );
    for (const r of rows) {
      const kind = r.fact_id === null ? "relation" : "fact";
      const id = (r.fact_id ?? r.relation_id) as number;
      built.push(
        ...extend(
          chainOf([{ edge: "DERIVED_FROM", from: insight, to: node(kind, id) }], [startRef]),
          tail(kind, id, r.id as number),
        ),
      );
    }
    for (const u of listInsightUserInputs(db, start.id)) {
      built.push(
        chainOf(
          [
            { edge: "DERIVED_FROM", from: insight, to: node(u.target, u.id) },
            { edge: "SUPPORTS", from: node(u.target, u.id), to: { kind: "user-input" } },
          ],
          [startRef, rowRef(u.target, u.id)],
        ),
      );
    }
    const inputs = db
      .all("SELECT link_id FROM insight_link_inputs WHERE insight_id = ? ORDER BY link_id", [
        start.id,
      ])
      .map((r) => r.link_id as number);
    const factIds = db
      .all(
        `SELECT from_fact_id, to_fact_id FROM assertion_links WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(inputs)],
      )
      .flatMap((r) => [r.from_fact_id as number, r.to_fact_id as number]);
    const wanted = new Set(inputs);
    for (const l of visibleLinks(
      db,
      registry,
      judge,
      linksOfFacts(db, factIds).filter((l) => wanted.has(l.id)),
    )) {
      built.push(
        ...extend(
          chainOf(
            [
              { edge: "DERIVED_FROM", from: insight, to: node("fact", l.fromFactId) },
              {
                edge: l.type,
                from: node("fact", l.fromFactId),
                to: node("fact", l.toFactId),
                linkId: l.id,
                direction: "forward",
              },
            ],
            [startRef, ref("fact", l.fromFactId), ref("assertion-link", l.id)],
          ),
          tail("fact", l.toFactId),
        ),
      );
    }
  } else {
    const top = view.topOf(start.id);
    const members = view.membersOfTop(top);
    for (const m of members) {
      const same = m === top;
      const prefixHops: TraceHop[] = same
        ? []
        : [{ edge: "SAME_AS", from: { kind: "item", id: top }, to: { kind: "item", id: m } }];
      const prefixRows = same ? [ref("item", m)] : [ref("item", top), ref("item", m)];
      const lineage = same ? [] : view.groupLineage(top);
      const rowsOf = [
        ...listSemanticFacts(db, m).map((f) => ["fact", f.id] as const),
        ...listSemanticRelations(db, m).map((r) => ["relation", r.id] as const),
      ];
      for (const [kind, id] of rowsOf) {
        built.push(
          ...extend(
            chainOf(
              [...prefixHops, { edge: "HAS", from: { kind: "item", id: m }, to: node(kind, id) }],
              prefixRows,
              lineage,
            ),
            tail(kind, id),
          ),
        );
      }
    }
  }

  const refs = [...new Map(built.flatMap((c) => c.rows).map((r) => [key(r), r])).values()];
  const ok = judge.shown(refs);
  const lineageOf = new Map<string, SourceVersionRef[]>();
  const lineage = (r: DerivedRef) => {
    const known = lineageOf.get(key(r));
    if (known) return known;
    const read = registry.lineage(db, r);
    lineageOf.set(key(r), read);
    return read;
  };
  const edgeOrder = (a: TraceHop[], b: TraceHop[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const [x, y] = [a[i] as TraceHop, b[i] as TraceHop];
      const kinds = x.edge.localeCompare(y.edge) || x.to.kind.localeCompare(y.to.kind);
      const ids =
        (x.to.kind === "user-input" ? 0 : x.to.id) - (y.to.kind === "user-input" ? 0 : y.to.id);
      if (kinds !== 0) return kinds;
      if (ids !== 0) return ids;
    }
    return a.length - b.length;
  };
  const chains = built
    .filter(
      (c) =>
        c.rows.every((r) => ok.has(key(r))) &&
        judge.together(unionOfVersions(c.lineage, ...c.rows.map(lineage))),
    )
    .map((c) => c.hops)
    .sort(edgeOrder);
  return {
    chains: chains.slice(0, GRAPH_CHAIN_LIMIT),
    truncated: chains.length > GRAPH_CHAIN_LIMIT,
  };
}
