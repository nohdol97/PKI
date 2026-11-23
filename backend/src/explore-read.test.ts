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

  it("answers `next` null once the store has been read to its end", () => {
    item("끝 하나", versions.open);
    expect(reads(100).items({ query: "끝" }).next).toBeNull();
  });
});

describe("explore-read item: owner, undo line and representative (X02F-C2)", () => {
  it("tags each fact with its owner, nulls the merge line of a member whose target is hidden, and names the representative of a member centre", () => {
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
    expect(answer.center?.facts.map((f) => [f.value, f.itemId])).toEqual([
      ["대표 값", rep],
      ["구성원 값", leaf],
    ]);
    expect(answer.center?.members).toEqual([expect.objectContaining({ id: leaf, mergeId: null })]);

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
