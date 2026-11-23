// The Wiki's pages from the canonical rows (K01-R1..R3): a page for each merge group's representative item
// and for each active Insight, a deterministic function of the stored state (rows in id order, keys written
// in a fixed order), so the same state gives the same bytes and the same hash. It reads; nothing is written
// here. A claim is one fact or relation row with its status, epistemic type, validity, evidence ids and the
// rows it contradicts or supersedes; the words a page reads in are the screen's (K01-D2). A Metric is read
// like any item: its status only, no check result (S03-R19).
import { createHash } from "node:crypto";
import {
  entityGroups,
  lineageOfItems,
  linksOfFacts,
  listEvidence,
  rowLineage,
  supersedingStands,
  unionOfVersions,
  type SourceVersionRef,
  type SqlDriver,
  type WikiLinkInput,
  type WikiPageInput,
} from "@pki/storage";
import { derivativeRegistry } from "./canonical-kinds.ts";

/** The page kinds (K01-R1); `index` and `log` are read from the stored pages, never stored. */
export const PAGE_KINDS = [
  "concepts",
  "projects",
  "people",
  "organizations",
  "systems",
  "decisions",
  "business-rules",
  "metrics",
  "tasks",
  "issues",
  "topics",
  "syntheses",
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** The kind of each item type that has one of its own; every other type lands in `topics` (K01-D6). */
const KIND_OF_TYPE: Readonly<Record<string, PageKind>> = {
  Concept: "concepts",
  Project: "projects",
  Person: "people",
  Organization: "organizations",
  System: "systems",
  Decision: "decisions",
  BusinessRule: "business-rules",
  Metric: "metrics",
  Task: "tasks",
  Commitment: "tasks",
  Issue: "issues",
  OpenQuestion: "issues",
};
export const pageKindOfType = (type: string): PageKind => KIND_OF_TYPE[type] ?? "topics";

/** Statuses a page does not carry (K01-D9): a rejected row is the user's "this is wrong". */
const NOT_CARRIED = "rejected";

export interface ClaimRef {
  kind: "fact" | "relation";
  id: number;
}

/** One line of a page: a fact (`value`) or a relation (`to`, the other end's page key). */
export interface WikiClaim {
  ref: ClaimRef;
  /** The fact kind, or the relation type. */
  kind: string;
  value?: string;
  context?: string | null;
  to?: string;
  status: string;
  epistemic: string;
  validAt: string | null;
  /** The row's own end; the effective end is worked out at read from the superseders the caller sees (S02-R24 1). */
  validUntil: string | null;
  /** The facts that stand as superseding this one, with the start of each: the read keeps those it may show. */
  supersededBy: { ref: ClaimRef; validAt: string | null }[];
  evidence: number[];
  contradicts: ClaimRef[];
  supersedes: ClaimRef[];
}

export interface WikiPageBody {
  members: { id: number; name: string }[];
  claims: WikiClaim[];
  /** `syntheses` only: the Insight's text, kind of knowledge, evidence ids and the two ends' page keys. */
  insight?: { summary: string; epistemic: string; evidence: number[]; ends: string[] };
}

export interface RenderedWikiPage extends WikiPageInput {
  /** The document `body` is the JSON of. */
  document: WikiPageBody;
}

const hashOf = (page: Omit<WikiPageInput, "contentHash">): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        page.key,
        page.kind,
        page.target,
        page.title,
        page.body,
        page.lineage.map((v) => `${v.sourceId}@${v.version}`),
        page.links.map((l) => `${l.toKey}|${l.basisKind}|${l.basisId}`),
      ]),
    )
    .digest("hex");

const ids = (list: readonly number[]) => JSON.stringify(list);

function itemPageKey(db: SqlDriver, itemId: number, cache: Map<number, string | undefined>) {
  if (cache.has(itemId)) return cache.get(itemId);
  const root = entityGroups.representativeOf(db, itemId);
  const type = db.all("SELECT type FROM items WHERE id = ?", [root])[0]?.type as string | undefined;
  const key = type === undefined ? undefined : `${pageKindOfType(type)}/${root}`;
  cache.set(itemId, key);
  return key;
}

/** The pages of the current state, ascending by key; only those named when `only` is given. */
export function renderWikiPages(db: SqlDriver, only?: ReadonlySet<string>): RenderedWikiPage[] {
  const keys = new Map<number, string | undefined>();
  const pages: RenderedWikiPage[] = [];
  const finish = (
    page: Omit<WikiPageInput, "contentHash" | "body">,
    document: WikiPageBody,
  ): void => {
    const body = JSON.stringify(document);
    pages.push({ ...page, body, document, contentHash: hashOf({ ...page, body }) });
  };

  const roots = db
    .all("SELECT id, type, name FROM items WHERE status <> ? ORDER BY id", [NOT_CARRIED])
    .filter((r) => entityGroups.representativeOf(db, r.id as number) === r.id);
  for (const root of roots) {
    const rootId = root.id as number;
    const key = `${pageKindOfType(root.type as string)}/${rootId}`;
    if (only && !only.has(key)) continue;
    const memberIds = entityGroups.membersOf(db, rootId);
    const members = db
      .all("SELECT id, name FROM items WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id", [
        ids(memberIds),
      ])
      .map((r) => ({ id: r.id as number, name: r.name as string }));
    const facts = db.all(
      `SELECT id, kind, value, context, status, epistemic, valid_at, valid_until FROM facts
        WHERE item_id IN (SELECT value FROM json_each(?)) AND status <> ? ORDER BY id`,
      [ids(memberIds), NOT_CARRIED],
    );
    const relations = db.all(
      `SELECT id, type, object_id, status, epistemic, valid_at, valid_until FROM relations
        WHERE subject_id IN (SELECT value FROM json_each(?)) AND status <> ? ORDER BY id`,
      [ids(memberIds), NOT_CARRIED],
    );
    const factIds = facts.map((f) => f.id as number);
    const own = new Set(factIds);
    const links = linksOfFacts(db, factIds).filter(
      (l) => own.has(l.fromFactId) && own.has(l.toFactId),
    );
    const refOf = (id: number): ClaimRef => ({ kind: "fact", id });
    const claims: WikiClaim[] = [
      ...facts.map((f): WikiClaim => {
        const id = f.id as number;
        const superseders = links.filter((l) => l.toFactId === id && supersedingStands(db, l));
        return {
          ref: refOf(id),
          kind: f.kind as string,
          value: f.value as string,
          context: f.context as string | null,
          status: f.status as string,
          epistemic: f.epistemic as string,
          validAt: f.valid_at as string | null,
          validUntil: f.valid_until as string | null,
          supersededBy: superseders.map((l) => ({
            ref: refOf(l.fromFactId),
            validAt: (db.all("SELECT valid_at FROM facts WHERE id = ?", [l.fromFactId])[0]
              ?.valid_at ?? null) as string | null,
          })),
          evidence: listEvidence(db, { factId: id })
            .filter((e) => e.current)
            .map((e) => e.id),
          contradicts: links
            .filter((l) => l.type === "CONTRADICTS" && (l.fromFactId === id || l.toFactId === id))
            .map((l) => refOf(l.fromFactId === id ? l.toFactId : l.fromFactId))
            .sort((a, b) => a.id - b.id),
          supersedes: links
            .filter((l) => l.type === "SUPERSEDES" && l.fromFactId === id)
            .map((l) => refOf(l.toFactId))
            .sort((a, b) => a.id - b.id),
        };
      }),
      ...relations.map((r): WikiClaim => {
        const id = r.id as number;
        return {
          ref: { kind: "relation", id },
          kind: r.type as string,
          to: itemPageKey(db, r.object_id as number, keys) ?? "",
          status: r.status as string,
          epistemic: r.epistemic as string,
          validAt: r.valid_at as string | null,
          validUntil: r.valid_until as string | null,
          supersededBy: [],
          evidence: listEvidence(db, { relationId: id })
            .filter((e) => e.current)
            .map((e) => e.id),
          contradicts: [],
          supersedes: [],
        };
      }),
    ];
    const pageLinks: WikiLinkInput[] = claims.flatMap((c) =>
      c.to && c.to !== key && c.ref.kind === "relation"
        ? [{ toKey: c.to, basisKind: "relation" as const, basisId: c.ref.id }]
        : [],
    );
    finish(
      {
        key,
        kind: pageKindOfType(root.type as string),
        target: String(rootId),
        title: root.name as string,
        // the sources of every row the body carries: an item the user wrote has none of its own, but the
        // facts and relations extraction attached to it do (a deletion must reach the page)
        lineage: unionOfVersions(
          lineageOfItems(db, memberIds),
          ...facts.map((f) => rowLineage(db, { kind: "fact", id: f.id as number })),
          ...relations.map((r) => rowLineage(db, { kind: "relation", id: r.id as number })),
        ),
        links: pageLinks,
      },
      { members, claims },
    );
  }

  for (const insight of db.all(
    "SELECT id, x_item_id, y_item_id, epistemic, summary FROM insights WHERE state = 'active' ORDER BY id",
  )) {
    const id = insight.id as number;
    if (only && !only.has(`syntheses/${id}`)) continue;
    const ends = [insight.x_item_id, insight.y_item_id].map((item) =>
      itemPageKey(db, item as number, keys),
    );
    const endKeys = [...new Set(ends.filter((k): k is string => k !== undefined))];
    const lineage: SourceVersionRef[] = derivativeRegistry.lineage(db, {
      kind: "insight",
      id: String(id),
    });
    finish(
      {
        key: `syntheses/${id}`,
        kind: "syntheses",
        target: String(id),
        title: insight.summary as string,
        lineage,
        links: endKeys.map((toKey) => ({ toKey, basisKind: "insight" as const, basisId: id })),
      },
      {
        members: [],
        claims: [],
        insight: {
          summary: insight.summary as string,
          epistemic: insight.epistemic as string,
          evidence: db
            .all(
              "SELECT evidence_id FROM insight_evidence WHERE insight_id = ? ORDER BY evidence_id",
              [id],
            )
            .map((r) => r.evidence_id as number),
          ends: endKeys,
        },
      },
    );
  }
  return pages.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
