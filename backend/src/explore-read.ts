// The Explore screen's reads (X02-R1..R4). Each is answered from rows the read gate shows (I04-R13, purpose
// `display`): a hidden item, fact, relation or source version is left out whole, and a number asked for that is
// hidden is the same `undefined` (the server's `not-found`) as one nothing is stored under. Visibility is applied
// before paging, so a hidden item neither shortens a page nor moves `next`. Nothing is stored here (X02-D2).
import { EXPLORE_PAGE_SIZE, type RouteRequest, type RouteResponse } from "@pki/contracts";
import { pageKindOfType, WIKI_PAGE_KIND_NAME } from "@pki/knowledge-engine";
import {
  listExploreItems,
  listSemanticFacts,
  listSemanticMembers,
  listSemanticRelations,
  readItem,
  readSourceVersionView,
  readStoredWikiPage,
  readValidIntervals,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import type { ReadGate } from "./read-gate.ts";

type Items = RouteResponse<"exploreItems">;
type Item = RouteResponse<"exploreItem">;
type Hop = NonNullable<RouteResponse<"graphPaths">["paths"]>[number][number];

/** Items read per round while filling a page, and the most items read for one page (provisional). */
const BATCH = 100;
const MAX_SCAN = 10_000;

export interface ExploreReads {
  items(request: RouteRequest<"exploreItems">): Items;
  /** undefined when the item is absent or not shown: the one answer for each. */
  item(request: RouteRequest<"exploreItem">): Item | undefined;
  /** The names of the items by number; an absent or hidden number is left out, not refused (X02B-R2). */
  names(request: RouteRequest<"exploreNames">): RouteResponse<"exploreNames">;
  /** undefined when the version is absent or not shown. */
  source(request: RouteRequest<"exploreSource">): RouteResponse<"exploreSource"> | undefined;
}

export function createExploreReads(
  db: SqlDriver,
  registry: DerivativeRegistry,
  gate: ReadGate,
): ExploreReads {
  const refOf = (id: number) => {
    const stored = readItem(db, id);
    return stored ? { id, type: stored.type, name: stored.name } : undefined;
  };
  const wikiKeyOf = (id: number, type: string): string | null => {
    const key = `${pageKindOfType(type)}/${id}`;
    return readStoredWikiPage(db, key) &&
      registry.visible(db, [{ kind: WIKI_PAGE_KIND_NAME, id: key }], "display").length === 1
      ? key
      : null;
  };
  return {
    items({ query, after }) {
      const kept: Items["items"] = [];
      let cursor = after ?? 0;
      let scanned = 0;
      // read on until a page and one more are shown (or the store ends): the one more says `next` exists
      while (kept.length <= EXPLORE_PAGE_SIZE && scanned < MAX_SCAN) {
        const rows = listExploreItems(db, { after: cursor, query, limit: BATCH });
        for (const row of rows) {
          cursor = row.id;
          if (!gate.semanticShown("item", row.id)) continue;
          // an alias counts only when its own fact is shown (X02B-R6 2): the first such value is the one answered
          const alias = row.nameMatch
            ? null
            : (row.aliases.find((a) => gate.semanticShown("fact", a.id))?.value ?? undefined);
          if (alias !== undefined) kept.push({ id: row.id, type: row.type, name: row.name, alias });
          if (kept.length > EXPLORE_PAGE_SIZE) break;
        }
        scanned += rows.length;
        if (rows.length < BATCH) break;
      }
      const page = kept.slice(0, EXPLORE_PAGE_SIZE);
      return {
        items: page,
        next: kept.length > EXPLORE_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
      };
    },
    item({ itemId, depth }) {
      if (!gate.semanticShown("item", itemId)) return undefined;
      const center = refOf(itemId);
      if (!center) return undefined;
      // the check above is the one that judges the centre; a start the walk cannot read has no neighbours
      const paths = gate.graphPaths({ from: itemId, depth }) ?? {
        status: "ok" as const,
        paths: [],
        truncated: false,
      };
      if (paths.status === "refused") return { status: "refused", reason: "depth-exceeded" };
      const walks = paths.paths ?? [];
      // the item's own rows and those of its shown members (S02-R13), each row judged by itself
      const members = listSemanticMembers(db, itemId).filter((m) =>
        gate.semanticShown("item", m.id),
      );
      const owners = [itemId, ...members.map((m) => m.id)];
      const facts = owners
        .flatMap((id) => listSemanticFacts(db, id))
        .filter((f) => gate.semanticShown("fact", f.id));
      const relations = owners
        .flatMap((id) => listSemanticRelations(db, id))
        // a relation whose other end is hidden is left out whole: its number would name that item (R4 4)
        .filter(
          (r) =>
            gate.semanticShown("relation", r.id) &&
            gate.semanticShown("item", r.subjectId) &&
            gate.semanticShown("item", r.objectId),
        );
      const factTimes = readValidIntervals(
        db,
        "facts",
        facts.map((f) => f.id),
      );
      const relationTimes = readValidIntervals(
        db,
        "relations",
        relations.map((r) => r.id),
      );
      const empty = { validAt: null, validUntil: null };
      // a path's hops are relations the gate showed, between items it showed: the neighbourhood is those
      const root = walks[0]?.[0]?.from ?? itemId;
      const steps = new Map<number, { hop: Hop; step: number }>();
      for (const path of walks)
        path.forEach((hop, i) => {
          const known = steps.get(hop.relationId);
          if (!known || known.step > i + 1) steps.set(hop.relationId, { hop, step: i + 1 });
        });
      const ends = new Set([...steps.values()].flatMap(({ hop }) => [hop.from, hop.to]));
      const neighbours = [...ends]
        .filter((id) => id !== itemId && id !== root && gate.semanticShown("item", id))
        .sort((a, b) => a - b);
      const open = new Set([itemId, root, ...neighbours]);
      return {
        status: "ok",
        center: {
          ...center,
          wikiKey: wikiKeyOf(itemId, center.type),
          members: members.map((m) => ({
            id: m.id,
            type: m.type,
            name: m.name,
            mergeId: m.mergeId,
          })),
          facts: facts.map((f) => ({ ...f, ...(factTimes.get(f.id) ?? empty) })),
          relations: relations.map((r) => ({ ...r, ...(relationTimes.get(r.id) ?? empty) })),
        },
        items: neighbours.flatMap((id) => refOf(id) ?? []),
        edges: [...steps.values()]
          .filter(({ hop }) => open.has(hop.from) && open.has(hop.to))
          .sort((a, b) => a.step - b.step || a.hop.relationId - b.hop.relationId)
          .map(({ hop, step }) => ({
            relationId: hop.relationId,
            type: hop.type,
            direction: hop.direction,
            from: hop.from,
            to: hop.to,
            step,
          })),
        truncated: paths.truncated ?? false,
      };
    },
    names({ ids }) {
      return {
        items: [...new Set(ids)].flatMap((id) =>
          gate.semanticShown("item", id) ? (refOf(id) ?? []) : [],
        ),
      };
    },
    source({ versionId, start }) {
      if (!gate.sourceShown(versionId)) return undefined;
      return readSourceVersionView(db, versionId, start);
    },
  };
}
