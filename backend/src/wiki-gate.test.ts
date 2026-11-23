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
  saveSourceRecord,
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
  const saved = saveSourceRecord(db, "c1", { externalId, title: `제목 ${externalId}`, body, accessScope });
  if (saved.status !== "created") throw new Error(saved.status);
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}
function citedFact(itemId: number, value: string, versionId: number): number {
  const factId = saveFact(db, { itemId, kind: "memo", value, ...attrs }).id;
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
