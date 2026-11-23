// K01-C3b ② (R9): the Wiki's read path under a scope policy that refuses one scope. A claim whose source is
// in the refused scope, and the name of a member that source alone gave, are not in the answer; a page whose
// target is hidden answers as a page that does not exist; the index lists the shown pages only.
import { createProductRegistry, planWikiBuild } from "@pki/knowledge-engine";
import {
  addEvidence,
  commitDerived,
  insertItem,
  migrate,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  setWikiSummary,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadGate } from "./read-gate.ts";
import { createWikiReads } from "./wiki-read.ts";

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const SECRET = "qzsecret";

/** Refuses every scope that names "secret"; everything else is allowed. */
const policy: ScopePolicy = {
  compare: () => "equal",
  strictest: (scopes) => scopes[0] ?? null,
  combinable: () => true,
  allows: (scopes) => !scopes.some((scope) => scope?.includes("secret")),
};

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

function source(externalId: string, body: string, accessScope: string[]) {
  const saved = saveSourceRecord(db, "c1", {
    externalId,
    title: `제목 ${externalId}`,
    body,
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}
function citedFact(
  itemId: number,
  value: string,
  versionId: number,
  extra: Partial<KnowledgeAttributes> = {},
): number {
  const factId = saveFact(db, { itemId, kind: "memo", value, ...attrs, ...extra }).id;
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [versionId])[0]
    ?.body as string;
  addEvidence(db, {
    target: { factId },
    sourceVersionId: versionId,
    start: 0,
    end: [...body].length,
    quote: body,
  });
  return factId;
}

describe("wiki.gate: what the policy refuses is not in the Wiki's answer", () => {
  it("leaves out the refused claim, its evidence and the member it alone gave, and answers a hidden target as no page", () => {
    const open = source("open", "공개 본문", ["open"]);
    const secret = source("secret", `${SECRET} 본문`, ["secret"]);
    const shown = insertItem(db, { type: "Project", name: "공개 항목", ...attrs });
    const alias = insertItem(db, { type: "Project", name: `${SECRET} 별칭`, ...attrs });
    const hidden = insertItem(db, { type: "System", name: `${SECRET} 다른 항목`, ...attrs });
    const openFact = citedFact(shown, "공개 값", open);
    citedFact(alias, `${SECRET} 값`, secret);
    citedFact(hidden, `${SECRET} 값`, secret);
    // the alias is a member of the shown item's group: one page holds both, from two scopes
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [alias, shown],
    );
    const plan = planWikiBuild(db, { at: "2026-11-23T00:00:00.000Z" });
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
    expect(
      db.all("SELECT body FROM wiki_pages WHERE key = ?", [`projects/${shown}`])[0]?.body,
    ).toContain(SECRET);

    const registry = createProductRegistry({ policy });
    const reads = createWikiReads(db, registry, createReadGate(db, registry));
    const page = reads.page(`projects/${shown}`);
    expect(page?.claims.map((c) => c.ref)).toEqual([{ kind: "fact", id: openFact }]);
    expect(page?.members.map((m) => m.name)).toEqual(["공개 항목"]);
    expect(JSON.stringify(page)).not.toContain(SECRET);

    // a hidden target and a key nothing is stored under are the one answer
    expect(reads.page(`systems/${hidden}`)).toBeUndefined();
    expect(reads.page("systems/999999")).toBeUndefined();
    const index = reads.index();
    expect(index.kinds.flatMap((k) => k.pages.map((p) => p.key))).toEqual([`projects/${shown}`]);
    expect(JSON.stringify(index)).not.toContain(SECRET);
  });
});

describe("wiki.gate: a stored summary is shown only when the whole lineage is (K01-R9, C4)", () => {
  it("answers `ready` with the sentences under a policy that allows every scope, and `none` without them when one scope is refused", () => {
    const open = source("open", "공개 본문", ["open"]);
    const secret = source("secret", `${SECRET} 본문`, ["secret"]);
    const shown = insertItem(db, { type: "Project", name: "공개 항목", ...attrs });
    const alias = insertItem(db, { type: "Project", name: `${SECRET} 별칭`, ...attrs });
    citedFact(shown, "공개 값", open);
    citedFact(alias, `${SECRET} 값`, secret);
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [alias, shown],
    );
    const plan = planWikiBuild(db, { at: "2026-11-23T00:00:00.000Z" });
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
    const key = `projects/${shown}`;
    const sentence = { sentence: `${SECRET} 요약`, sourceId: 1, version: 1, start: 0, end: 2 };
    setWikiSummary(db, true, new Date());
    db.run("UPDATE wiki_pages SET summary = ?, summary_hash = content_hash WHERE key = ?", [
      JSON.stringify([sentence]),
      key,
    ]);

    const allowAll = createProductRegistry({
      policy: { ...policy, allows: () => true },
    });
    const everything = createWikiReads(db, allowAll, createReadGate(db, allowAll));
    expect(everything.page(key)?.summary.state).toBe("ready");

    // every scope allowed but the two not to be put together: the summary mixes them, so it is not shown
    const apart = createProductRegistry({
      policy: {
        ...policy,
        allows: () => true,
        combinable: (scopes) => new Set(scopes.map((s) => JSON.stringify(s))).size <= 1,
      },
    });
    expect(createWikiReads(db, apart, createReadGate(db, apart)).page(key)?.summary).toEqual({
      state: "none",
    });

    const registry = createProductRegistry({ policy });
    const reads = createWikiReads(db, registry, createReadGate(db, registry));
    const page = reads.page(key);
    expect(page?.summary).toEqual({ state: "none" });
    expect(JSON.stringify(page)).not.toContain(`${SECRET} 요약`);
  });
});

describe("wiki.gate: what a link between two facts may disclose", () => {
  const link = (type: "SUPERSEDES" | "CONTRADICTS", from: number, to: number) =>
    db.run(
      "INSERT INTO assertion_links (type, from_fact_id, to_fact_id, created_by, at) VALUES (?, ?, ?, 'rule', 'x')",
      [type, from, to],
    );
  const merge = (member: number, representative: number) =>
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [member, representative],
    );
  const build = () => {
    const plan = planWikiBuild(db, { at: "2026-11-23T00:00:00.000Z" });
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
  };
  const readsOf = (policyOf: ScopePolicy) => {
    const registry = createProductRegistry({ policy: policyOf });
    return createWikiReads(db, registry, createReadGate(db, registry));
  };

  it("does not carry the date of a superseding fact the caller cannot see (S02-R24 1)", () => {
    const open = source("open", "공개 본문", ["open"]);
    const secret = source("secret", `${SECRET} 본문`, ["secret"]);
    const shown = insertItem(db, { type: "Project", name: "공개 항목", ...attrs });
    const alias = insertItem(db, { type: "Project", name: `${SECRET} 별칭`, ...attrs });
    merge(alias, shown);
    const old = citedFact(shown, "옛 값", open);
    const next = citedFact(alias, `${SECRET} 값`, secret, { validAt: "2031-07-07" });
    link("SUPERSEDES", next, old);
    build();

    const page = readsOf(policy).page(`projects/${shown}`);
    expect(page?.claims.map((c) => [c.ref.id, c.validUntil])).toEqual([[old, null]]);
    expect(JSON.stringify(page)).not.toContain("2031-07-07");
    // the same link read by one who may see both ends does end the old value
    const open2 = readsOf({ ...policy, allows: () => true }).page(`projects/${shown}`);
    expect(open2?.claims.find((c) => c.ref.id === old)?.validUntil).toBe("2031-07-07");
  });

  it("keeps no contradicts/supersedes link and no superseder-derived end when the policy refuses the two ends together (S02-R24)", () => {
    const a = source("a", "가 본문", ["A"]);
    const b = source("b", "나 본문", ["B"]);
    const x = insertItem(db, { type: "Project", name: "항목", ...attrs });
    const fa = citedFact(x, "가 값", a);
    const fb = citedFact(x, "나 값", b);
    const fc = citedFact(x, "가 새 값", a, { validAt: "2031-08-08" });
    link("CONTRADICTS", fa, fb);
    link("SUPERSEDES", fc, fb);
    build();
    const noAB: ScopePolicy = {
      ...policy,
      combinable: (scopes) =>
        !(scopes.some((s) => s?.includes("A")) && scopes.some((s) => s?.includes("B"))),
    };

    const together = readsOf(policy).page(`projects/${x}`);
    expect(together?.claims.find((c) => c.ref.id === fa)?.contradicts).toEqual([
      { kind: "fact", id: fb },
    ]);
    expect(together?.claims.find((c) => c.ref.id === fc)?.supersedes).toEqual([
      { kind: "fact", id: fb },
    ]);
    expect(together?.claims.find((c) => c.ref.id === fb)?.validUntil).toBe("2031-08-08");

    const page = readsOf(noAB).page(`projects/${x}`);
    expect(page?.claims.map((c) => c.ref.id)).toEqual([fa, fb, fc]);
    expect(page?.claims.flatMap((c) => [...c.contradicts, ...c.supersedes])).toEqual([]);
    expect(page?.claims.find((c) => c.ref.id === fb)?.validUntil).toBeNull();
  });
});

describe("wiki.gate: a merge line the caller cannot see is not a group (S02-R24 4, K01-R9)", () => {
  /** Shows each scope alone but refuses the two sources of one merge line together, so the line is hidden. */
  const crossing: ScopePolicy = {
    ...policy,
    allows: (scopes) =>
      !(scopes.some((s) => s?.includes("A")) && scopes.some((s) => s?.includes("B"))),
  };
  const mergeLine = (member: number, representative: number) =>
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [member, representative],
    );

  it("shows neither the other member's name, claims nor the backlink derived through it", () => {
    const a = source("a", "가 본문", ["A"]);
    const b = source("b", "나 본문", ["B"]);
    const rep = insertItem(db, { type: "Project", name: "대표 항목", ...attrs });
    const member = insertItem(db, { type: "Project", name: "숨은별칭", ...attrs });
    const target = insertItem(db, { type: "Project", name: "대상 항목", ...attrs });
    const repFact = citedFact(rep, "가 값", a);
    citedFact(member, "나비밀값", b);
    mergeLine(member, rep);
    // the member's relation reaches `target`: a backlink on its page would name the representative's page
    const rel = saveRelation(db, {
      subjectId: member,
      type: "USES",
      objectId: target,
      ...attrs,
    }).id;
    addEvidence(db, {
      target: { relationId: rel },
      sourceVersionId: b,
      start: 0,
      end: 1,
      quote: "나",
    });
    const plan = planWikiBuild(db, { at: "2026-11-23T00:00:00.000Z" });
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));

    const registry = createProductRegistry({ policy: crossing });
    const reads = createWikiReads(db, registry, createReadGate(db, registry));
    const page = reads.page(`projects/${rep}`);
    expect(page?.claims.map((c) => c.ref)).toEqual([{ kind: "fact", id: repFact }]);
    expect(page?.members.map((m) => m.name)).toEqual(["대표 항목"]);
    expect(JSON.stringify(page)).not.toContain("숨은별칭");
    expect(JSON.stringify(page)).not.toContain("나비밀값");
    expect(page?.links).toEqual([]);
    expect(reads.page(`projects/${target}`)?.backlinks).toEqual([]);

    // the same rows read by one who may put the two together show the group
    const open = createProductRegistry({ policy });
    const together = createWikiReads(db, open, createReadGate(db, open));
    expect(together.page(`projects/${rep}`)?.members.map((m) => m.name)).toEqual([
      "대표 항목",
      "숨은별칭",
    ]);
    expect(together.page(`projects/${target}`)?.backlinks.map((l) => l.fromKey)).toEqual([
      `projects/${rep}`,
    ]);
  });
});

describe("wiki.gate: the object side of a relation and an Insight's ends read the same group view (S02-R24 4, K01-R9)", () => {
  const crossing: ScopePolicy = {
    ...policy,
    allows: (scopes) =>
      !(scopes.some((s) => s?.includes("A")) && scopes.some((s) => s?.includes("B"))),
  };

  /** The C3b ⑥ world: X relates to a merge member whose source is in scope B, X itself is in scope A. */
  const relationWorld = () => {
    const a = source("a", "가 본문", ["A"]);
    const b = source("b", "나 본문", ["B"]);
    const rep = insertItem(db, { type: "Project", name: "대표 항목", ...attrs });
    const member = insertItem(db, { type: "Project", name: "숨은별칭", ...attrs });
    const x = insertItem(db, { type: "Project", name: "다른 항목", ...attrs });
    citedFact(rep, "가 값", a);
    citedFact(member, "나 값", b);
    citedFact(x, "엑스 값", a);
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [member, rep],
    );
    // X's relation ends at the hidden member; an Insight joins X and the same member
    const rel = saveRelation(db, { subjectId: x, type: "USES", objectId: member, ...attrs }).id;
    addEvidence(db, {
      target: { relationId: rel },
      sourceVersionId: a,
      start: 0,
      end: 1,
      quote: "가",
    });
    db.run(
      "INSERT INTO insights (rule, x_item_id, y_item_id, epistemic, state, summary) VALUES ('r', ?, ?, 'explicit', 'active', '요약')",
      [x, member],
    );
    const plan = planWikiBuild(db, { at: "2026-11-23T00:00:00.000Z" });
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
    return { x, rep };
  };

  it("names no page and no backlink that would show a hidden merge member's page is the representative's", () => {
    const { x, rep } = relationWorld();

    const registry = createProductRegistry({ policy: crossing });
    const reads = createWikiReads(db, registry, createReadGate(db, registry));
    const xPage = reads.page(`projects/${x}`);
    expect(xPage?.claims.filter((c) => c.ref.kind === "relation")).toEqual([]);
    expect(xPage?.links.map((l) => l.key)).not.toContain(`projects/${rep}`);
    expect(reads.page(`projects/${rep}`)?.backlinks).toEqual([]);
    // the member end is not shown to this reader, so the Insight page is none (P01-R15, D30)
    expect(reads.page("syntheses/1")).toBeUndefined();

    // read by one who may put the two together, the same rows show
    const open = createProductRegistry({ policy });
    const together = createWikiReads(db, open, createReadGate(db, open));
    expect(
      together
        .page(`projects/${rep}`)
        ?.backlinks.map((l) => l.basisKind)
        .sort(),
    ).toEqual(["insight", "relation"]);
    expect(together.page("syntheses/1")?.links.map((l) => l.key)).toContain(`projects/${rep}`);
  });

  it("gives no change count for a page whose relation claim names an end the reader cannot see (K01-R18 2, C6)", () => {
    const { x } = relationWorld();
    const key = `projects/${x}`;
    const readsOf = (p: ScopePolicy) => {
      const registry = createProductRegistry({ policy: p });
      return createWikiReads(db, registry, createReadGate(db, registry));
    };
    const narrow = readsOf(crossing);
    expect(narrow.page(key)?.history.map((h) => h.added)).toEqual([0]);
    expect(
      narrow
        .index()
        .log.filter((l) => l.pageKey === key)
        .map((l) => l.added),
    ).toEqual([0]);
    // read by one who may put the two together: a fact and a relation
    expect(
      readsOf(policy)
        .page(key)
        ?.history.map((h) => h.added),
    ).toEqual([2]);
  });
});

describe("wiki.gate: an Insight page follows the end-item rule (P01-R15, D30)", () => {
  it("is no page, no index entry and no backlink while an end item is not shown", () => {
    const open = source("open", "공개 본문", ["open"]);
    const secret = source("secret", `${SECRET} 본문`, ["secret"]);
    const x = insertItem(db, { type: "Project", name: "공개 항목", ...attrs });
    const y = insertItem(db, { type: "Project", name: `${SECRET} 항목`, ...attrs });
    citedFact(x, "공개 값", open);
    citedFact(y, `${SECRET} 값`, secret);
    db.run(
      "INSERT INTO insights (rule, x_item_id, y_item_id, epistemic, state, summary) VALUES ('r', ?, ?, 'explicit', 'active', '요약')",
      [x, y],
    );
    const plan = planWikiBuild(db, { at: "2026-11-23T00:00:00.000Z" });
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));

    const registry = createProductRegistry({ policy });
    const reads = createWikiReads(db, registry, createReadGate(db, registry));
    expect(reads.page("syntheses/1")).toBeUndefined();
    expect(reads.index().kinds.map((k) => k.kind)).not.toContain("syntheses");
    expect(reads.page(`projects/${x}`)?.backlinks).toEqual([]);
  });
});

describe("wiki.hidden: a hidden claim stays reachable for the way back (K01-R11, R15)", () => {
  it("is listed in `hidden` and not in `claims` on a later read, back in `claims` after unhide, and judged by the same gate", () => {
    const open = source("open", "공개 본문", ["open"]);
    const secret = source("secret", `${SECRET} 본문`, ["secret"]);
    const item = insertItem(db, { type: "Project", name: "공개 항목", ...attrs });
    const keep = citedFact(item, "남는 값", open);
    const gone = citedFact(item, "숨길 값", open);
    const alias = insertItem(db, { type: "Project", name: `${SECRET} 별칭`, ...attrs });
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [alias, item],
    );
    const refused = citedFact(alias, `${SECRET} 값`, secret);
    const plan = planWikiBuild(db, { at: "2026-11-23T00:00:00.000Z" });
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
    const key = `projects/${item}`;
    const registry = createProductRegistry({ policy: { ...policy, allows: () => true } });
    const reads = createWikiReads(db, registry, createReadGate(db, registry));

    for (const id of [gone, refused]) {
      expect(reads.edit({ op: "hide", claim: { kind: "fact", id } }, "x")).toEqual({
        status: "applied",
      });
    }
    const hidden = reads.page(key);
    expect(hidden?.claims.map((c) => c.ref.id)).toEqual([keep]);
    expect(hidden?.hidden.map((c) => c.ref.id)).toEqual([gone, refused]);

    reads.edit({ op: "unhide", claim: { kind: "fact", id: gone } }, "x");
    const back = reads.page(key);
    expect(back?.claims.map((c) => c.ref.id)).toEqual([keep, gone]);
    expect(back?.hidden.map((c) => c.ref.id)).toEqual([refused]);

    // a hidden claim the policy refuses is not listed either
    const refusing = createProductRegistry({ policy });
    const guarded = createWikiReads(db, refusing, createReadGate(db, refusing)).page(key);
    expect(guarded?.hidden).toEqual([]);
    expect(JSON.stringify(guarded)).not.toContain(SECRET);
  });
});

describe("wiki.gate: change counts do not reveal claims the caller cannot see (#220, K01-D19)", () => {
  it("zeroes the added and removed counts of a page that holds a refused claim, in its history and in the index log", () => {
    const open = source("open", "공개 본문", ["open"]);
    const secret = source("secret", `${SECRET} 본문`, ["secret"]);
    const item = insertItem(db, { type: "Project", name: "공개 항목", ...attrs });
    citedFact(item, "공개 값", open);
    const build = (at: string) =>
      db.transaction(() =>
        commitDerived(db, { source: null, items: planWikiBuild(db, { at }).items }),
      );
    build("2026-11-23T00:00:00.000Z");
    const alias = insertItem(db, { type: "Project", name: `${SECRET} 별칭`, ...attrs });
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [alias, item],
    );
    citedFact(alias, `${SECRET} 값`, secret);
    build("2026-11-23T00:01:00.000Z");
    const key = `projects/${item}`;
    const readsOf = (p: ScopePolicy) => {
      const registry = createProductRegistry({ policy: p });
      return createWikiReads(db, registry, createReadGate(db, registry));
    };
    const counts = (reads: ReturnType<typeof readsOf>) => ({
      history: reads.page(key)?.history.map((h) => h.added),
      log: reads.index().log.map((l) => l.added),
    });

    expect(counts(readsOf({ ...policy, allows: () => true }))).toEqual({
      history: [1, 1],
      log: [1, 1],
    });
    const restricted = counts(readsOf(policy));
    expect(restricted.history).toEqual([0, 0]);
    expect(restricted.log).toEqual([0, 0]);
  });

  it("gives a line's added count only while no later line of the page removed a claim, and never a removed count (K01-R18 1, C5)", () => {
    const open = source("open", "공개 본문", ["open"]);
    const secret = source("secret", `${SECRET} 본문`, ["secret"]);
    const item = insertItem(db, { type: "Project", name: "공개 항목", ...attrs });
    citedFact(item, "공개 값", open);
    const build = (at: string) =>
      db.transaction(() =>
        commitDerived(db, { source: null, items: planWikiBuild(db, { at }).items }),
      );
    const key = `projects/${item}`;
    build("2026-11-23T00:00:00.000Z");
    const alias = insertItem(db, { type: "Project", name: `${SECRET} 별칭`, ...attrs });
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [alias, item],
    );
    const hiddenFact = citedFact(alias, `${SECRET} 값`, secret);
    build("2026-11-23T00:01:00.000Z");
    // the refused claim leaves the page: the merge that brought it in is undone (a direct status change is
    // refused by the lifecycle gate)
    db.run("UPDATE item_merges SET active = 0 WHERE member_id = ?", [alias]);
    build("2026-11-23T00:02:00.000Z");
    const stored = db.all("SELECT body FROM wiki_pages WHERE key = ?", [key])[0]?.body as string;
    expect(stored).not.toContain(`"id":${hiddenFact}`);
    expect(
      db.all("SELECT removed FROM wiki_log WHERE page_key = ? ORDER BY id DESC", [key])[0]?.removed,
    ).toBe(1);
    citedFact(item, "공개 값 2", open);
    build("2026-11-23T00:03:00.000Z");

    for (const p of [policy, { ...policy, allows: () => true }]) {
      const registry = createProductRegistry({ policy: p });
      const reads = createWikiReads(db, registry, createReadGate(db, registry));
      const pairs = (l: { added: number; removed: number }[]) => l.map((h) => [h.added, h.removed]);
      expect(pairs(reads.page(key)?.history ?? [])).toEqual([
        [0, 0],
        [0, 0],
        [0, 0],
        [1, 0],
      ]);
      expect(pairs(reads.index().log.filter((l) => l.pageKey === key))).toEqual([
        [1, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ]);
    }
  });
});
