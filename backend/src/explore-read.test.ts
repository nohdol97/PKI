// X02F-C1 and C2: the Explore reads at the scan cap, and the owner and undo fields of an item's answer.
// Built on `createExploreReads` directly with a lowered cap and a policy that hides one scope. Synthetic data only.
import { createProductRegistry } from "@pki/knowledge-engine";
import {
  addEvidence,
  automatedLifecycle,
  createDerivativeRegistry,
  defaultScopePolicy,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { dirTemplate } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productUserDecisions } from "./composition.ts";
import { createExploreReads } from "./explore-read.ts";
import { createReadGate } from "./read-gate.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());
const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-23T00:00:00Z",
} as const;
const registry = createDerivativeRegistry({
  kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
  policy: { ...defaultScopePolicy, allows: (scopes) => !scopes.some((s) => s?.includes("secret")) },
});

let dir: string;
let db: SqlDriver;
let versions: { open: number; secret: number };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-explore-read-"));
  seedDataDir(dir);
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
  versions = { open: source("a", null), secret: source("b", ["secret"]) };
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function source(externalId: string, accessScope: string[] | null): number {
  const saved = saveSourceRecord(db, "c", {
    externalId,
    title: `제목 ${externalId}`,
    body: "본문 합성",
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}
/** An item with one fact citing `versionId`: it is shown exactly when that version is. */
function item(name: string, versionId: number, value = "값") {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", null);
  const fact = saveFact(db, { itemId: id, kind: "memo", value, ...attrs }).id;
  automatedLifecycle.created(db, { kind: "fact", id: fact }, "extraction", null);
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: versionId,
    start: 0,
    end: 2,
    quote: "본문",
  });
  return id;
}
const reads = (maxScan?: number) =>
  createExploreReads(db, registry, createReadGate(db, registry), maxScan ? { maxScan } : {});

describe("explore-read items at the scan cap (X02F-C1)", () => {
  it("answers `next` as the last shown number, never the hidden row read after it, and following it reaches the shown items beyond the cap", () => {
    const first = item("범위 처음", versions.open);
    for (let i = 0; i < 99; i++) item(`범위 가림 ${i}`, versions.secret);
    const beyond = Array.from({ length: 3 }, (_, i) => item(`범위 뒤 ${i}`, versions.open));
    const read = reads(100);
    const page = read.items({ query: "범위" });
    // the window of 100 rows ends on a hidden row (number 100): its number is not answered
    expect(page.next).toBe(first);
    const seen = [...page.items.map((i) => i.id)];
    let next = page.next;
    while (next !== null) {
      const more = read.items({ query: "범위", after: next });
      seen.push(...more.items.map((i) => i.id));
      next = more.next;
    }
    expect(seen).toEqual([first, ...beyond]);
  });

  it("does not answer as `next` the number of a shown item that the query reaches only through a hidden alias fact", () => {
    for (let i = 0; i < 99; i++) item(`별칭 가림 ${i}`, versions.secret);
    // a user-made item has no lineage of its own, so it is shown while its alias fact (citing the secret source) is not
    const added = productUserDecisions(registry).add(db, {
      kind: "item",
      type: "Project",
      name: "엑스",
    });
    if (added.status !== "applied") throw new Error("add");
    const fact = saveFact(db, {
      itemId: added.ref.id,
      kind: "alias.name",
      value: "별칭비밀",
      ...attrs,
    }).id;
    automatedLifecycle.created(db, { kind: "fact", id: fact }, "extraction", null);
    addEvidence(db, {
      target: { factId: fact },
      sourceVersionId: versions.secret,
      start: 0,
      end: 2,
      quote: "본문",
    });
    for (let i = 0; i < 3; i++) item(`별칭 뒤 ${i}`, versions.open);
    // the window of 100 rows holds only hidden rows and that item: nothing in it may be named
    expect(reads(100).items({ query: "별칭" })).toEqual({ items: [], next: null });
  });

  it("answers `next` null once the store has been read to its end", () => {
    item("끝 하나", versions.open);
    expect(reads(100).items({ query: "끝" }).next).toBeNull();
  });
});

describe("explore-read item: owner, undo line and representative (X02F-C2)", () => {
  it("tags each fact with its owner, leaves out a member behind a hidden item (MGV-C1), and names the representative of a member centre", () => {
    const rep = item("대표", versions.open, "대표 값");
    const hiddenMid = item("가려진 중간", versions.secret);
    const leaf = item("끝 구성원", versions.open, "구성원 값");
    const other = item("이웃", versions.open);
    const decisions = productUserDecisions(registry);
    // leaf joins the hidden middle item, which joins the representative: leaf's line points at a hidden item
    expect(decisions.entities.merge(db, leaf, hiddenMid).status).toBe("applied");
    expect(decisions.entities.merge(db, hiddenMid, rep).status).toBe("applied");
    const answer = reads().item({ itemId: rep, depth: 1 });
    if (answer?.status !== "ok") throw new Error("not ok");
    expect(answer.center?.facts.map((f) => [f.value, f.itemId])).toEqual([["대표 값", rep]]);
    expect(answer.center?.members).toEqual([]);
    // the leaf itself is shown: opened by its own number it is a lone item
    expect(reads().item({ itemId: leaf, depth: 1 })?.status).toBe("ok");

    // a shown target keeps its line number
    const visible = item("보이는 대표", versions.open);
    const member = item("보이는 구성원", versions.open);
    const merged = decisions.entities.merge(db, member, visible);
    if (merged.status !== "applied") throw new Error("merge");
    const shown = reads().item({ itemId: visible, depth: 1 });
    expect(shown?.center?.members[0]?.mergeId).toBe(merged.mergeId);

    // the member as the centre: its relations walk from the representative, which is then named in `items`
    const rel = saveRelation(db, {
      subjectId: visible,
      type: "DEPENDS_ON",
      objectId: other,
      ...attrs,
    }).id;
    automatedLifecycle.created(db, { kind: "relation", id: rel }, "extraction", null);
    addEvidence(db, {
      target: { relationId: rel },
      sourceVersionId: versions.open,
      start: 0,
      end: 2,
      quote: "본문",
    });
    const fromMember = reads().item({ itemId: member, depth: 1 });
    expect(fromMember?.edges?.[0]?.from).toBe(visible);
    expect(fromMember?.items).toContainEqual({ id: visible, type: "Project", name: "보이는 대표" });
  });
});

describe("explore-read item: a member is carried only while its merge line is shown (RVS-C2)", () => {
  /** Two items of different scopes, merged; the policy hides a line that joins two scopes, not either item. */
  function merged(allows: (scopes: readonly unknown[]) => boolean) {
    const joined = createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy: { ...defaultScopePolicy, allows },
    });
    const rep = item("합침 대표", source("m-a", ["a"]), "대표 값");
    const member = item("합침 구성원", source("m-b", ["b"]), "구성원 값");
    const done = productUserDecisions(joined).entities.merge(db, member, rep);
    if (done.status !== "applied") throw new Error("merge");
    return {
      rep,
      member,
      mergeId: done.mergeId,
      reads: createExploreReads(db, joined, createReadGate(db, joined)),
    };
  }

  it("leaves out the member and its facts when the line is hidden", () => {
    const hidden = merged((scopes) => scopes.length < 2);
    const answer = hidden.reads.item({ itemId: hidden.rep, depth: 1 });
    if (answer?.status !== "ok") throw new Error("not ok");
    expect(answer.center?.members).toEqual([]);
    expect(answer.center?.facts.map((f) => f.value)).toEqual(["대표 값"]);
  });

  it("carries the member with its line number when the policy shows the line", () => {
    const open = merged(() => true);
    const answer = open.reads.item({ itemId: open.rep, depth: 1 });
    if (answer?.status !== "ok") throw new Error("not ok");
    expect(answer.center?.members).toEqual([
      expect.objectContaining({ id: open.member, mergeId: open.mergeId }),
    ]);
    expect(answer.center?.facts.map((f) => f.value)).toEqual(["대표 값", "구성원 값"]);
  });
});

describe("explore-read item: a member centre whose own line is hidden carries no sibling (MGV-C2)", () => {
  it("leaves out the sibling of another scope's line, and the sibling's facts", () => {
    // the policy refuses scope a and scope b together: the centre's line (b to a) is hidden, the sibling's (a to a) is not
    const split = createDerivativeRegistry({
      kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
      policy: {
        ...defaultScopePolicy,
        allows: (scopes) =>
          !(scopes.some((s) => s?.includes("a")) && scopes.some((s) => s?.includes("b"))),
      },
    });
    const rep = item("분리 대표", source("g-a", ["a"]), "대표 값");
    const centre = item("분리 가운데", source("g-b", ["b"]), "가운데 값");
    const sibling = item("분리 형제", source("g-c", ["a"]), "형제 값");
    const decisions = productUserDecisions(split);
    expect(decisions.entities.merge(db, centre, rep).status).toBe("applied");
    expect(decisions.entities.merge(db, sibling, rep).status).toBe("applied");
    const answer = createExploreReads(db, split, createReadGate(db, split)).item({
      itemId: centre,
      depth: 1,
    });
    if (answer?.status !== "ok") throw new Error("not ok");
    expect(answer.center?.members).toEqual([]);
    expect(answer.center?.facts.map((f) => f.value)).toEqual(["가운데 값"]);
  });
});

describe("explore-read item: a member centre still carries its siblings (RVS-R2)", () => {
  it("lists the other member of the group and its facts when the centre is itself a member", () => {
    const rep = item("형제 대표", versions.open, "대표 값");
    const centre = item("형제 가운데", versions.open, "가운데 값");
    const sibling = item("형제 구성원", versions.open, "형제 값");
    const decisions = productUserDecisions(registry);
    expect(decisions.entities.merge(db, centre, rep).status).toBe("applied");
    expect(decisions.entities.merge(db, sibling, rep).status).toBe("applied");
    const answer = reads().item({ itemId: centre, depth: 1 });
    if (answer?.status !== "ok") throw new Error("not ok");
    expect(answer.center?.members.map((m) => m.id)).toContain(sibling);
    expect(answer.center?.facts.map((f) => f.value)).toContain("형제 값");
  });
});
