// K02-C3b ① ③ (R12, R14): the lint's read path. After one closing and one "missed" report the rule's counts hold
// one false positive and one miss; under a scope policy that refuses one scope, a finding that rests on a
// source of that scope is in neither the list nor the counts, and the decision on it answers `not-found`.
import { createProductRegistry, planReflect } from "@pki/knowledge-engine";
import {
  addEvidence,
  commitDerived,
  insertItem,
  migrate,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  userDecisions,
  type DerivativeRegistry,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLintReads } from "./lint-read.ts";
import { createReadGate } from "./read-gate.ts";

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const AT = "2026-11-23T00:00:00.000Z";
const SECRET = "qzsecret";

const allowAll: ScopePolicy = {
  compare: () => "equal",
  strictest: (scopes) => scopes[0] ?? null,
  combinable: () => true,
  allows: () => true,
};
/** Refuses every scope that names "secret"; everything else is allowed. */
const refuseSecret: ScopePolicy = {
  ...allowAll,
  allows: (scopes) => !scopes.some((scope) => scope?.includes("secret")),
};

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

/** A Task past its target date, cited by a source of `scope`; the finding the rule opens is of that source. */
function overdueTask(name: string, scope: string) {
  const saved = saveSourceRecord(db, "c1", {
    externalId: name,
    title: `제목 ${name}`,
    body: `${name} 본문`,
    accessScope: [scope],
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const itemId = insertItem(db, { type: "Task", name, ...attrs });
  const factId = saveFact(db, {
    itemId,
    kind: "target_date",
    value: "2026-01-15",
    ...attrs,
  }).id;
  addEvidence(db, {
    target: { factId },
    sourceVersionId: versionId,
    start: 0,
    end: [...`${name} 본문`].length,
    quote: `${name} 본문`,
  });
  return itemId;
}

function reads(policy: ScopePolicy) {
  const registry: DerivativeRegistry = createProductRegistry({ policy });
  return createLintReads(
    db,
    registry,
    createReadGate(db, registry),
    () => userDecisions,
    () => undefined,
  );
}
const reflect = () => {
  const plan = planReflect(db, "daily", AT, {});
  db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
};
const overdue = (r: ReturnType<typeof reads>) =>
  r.list().counts.find((c) => c.rule === "overdue-work");

describe("lint.gate: counts of false positives and misses (K02-C3b ①)", () => {
  it("holds one false positive after a closing and one miss after a report, for the same rule", () => {
    const found = overdueTask("공개 업무", "open");
    const other = insertItem(db, { type: "Task", name: "다른 업무", ...attrs });
    reflect();
    const lint = reads(allowAll);
    const finding = lint.list().findings.find((f) => f.rule === "overdue-work");
    expect(finding?.targets[0]?.id).toBe(found);

    expect(lint.decide({ id: finding?.id as number, op: "dismiss" }, AT).status).toBe("applied");
    const missed = lint.report({ rule: "overdue-work", kind: "item", a: other }, AT);
    expect(missed).toMatchObject({
      status: "applied",
      finding: { origin: "user", status: "open" },
    });

    expect(overdue(lint)).toEqual({
      rule: "overdue-work",
      open: 1, // the reported one is an open finding too
      accepted: 0,
      falsePositive: 1,
      missed: 1,
      oscillating: 0,
    });
  });
});

describe("lint.gate: what the policy refuses is not in the answer (K02-C3b ③)", () => {
  it("leaves the finding of the refused scope out of the list and the counts, and answers its decision as not found", () => {
    overdueTask("공개 업무", "open");
    const hidden = overdueTask(`${SECRET} 업무`, "secret");
    reflect();
    expect(db.all("SELECT count(*) AS n FROM lint_findings")[0]?.n).toBe(2);

    const lint = reads(refuseSecret);
    const answer = lint.list();
    expect(answer.findings.map((f) => f.targets[0]?.label)).toEqual(["공개 업무"]);
    expect(overdue(lint)?.open).toBe(1);
    expect(JSON.stringify(answer)).not.toContain(SECRET);

    const hiddenId = db.all("SELECT id FROM lint_findings WHERE target_a = ?", [hidden])[0]
      ?.id as number;
    expect(lint.decide({ id: hiddenId, op: "dismiss" }, AT)).toEqual({ status: "not-found" });
    expect(db.all("SELECT status FROM lint_findings WHERE id = ?", [hiddenId])[0]?.status).toBe(
      "open",
    );
    // the one answer for a finding that is hidden and one that is not stored
    expect(lint.decide({ id: 999_999, op: "dismiss" }, AT)).toEqual({ status: "not-found" });
  });
});

/** A source of `scope` with its own body; the id of its stored version row. */
function sourceOf(name: string, scope: string, body = `${name} 본문`) {
  const saved = saveSourceRecord(db, "c1", {
    externalId: name,
    title: name,
    body,
    accessScope: [scope],
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}
function cited(itemId: number, kind: string, value: string, versionId: number) {
  const factId = saveFact(db, { itemId, kind, value, ...attrs }).id;
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

describe("lint.gate: a finding does not name an item the caller may not see (K02 review B-F1)", () => {
  it("shows no stale finding of a hidden item, and a report on its fact answers not-found and stores nothing", () => {
    const secret = sourceOf("secret", "secret");
    sourceOf("pub", "open", "공개 본문 하나");
    saveSourceRecord(db, "c1", {
      externalId: "pub",
      title: "pub",
      body: "공개 본문 둘",
      accessScope: ["open"],
    });
    const oldVersion = db.all("SELECT id FROM source_versions WHERE body = '공개 본문 하나'")[0]
      ?.id as number;
    const hidden = insertItem(db, { type: "Person", name: `${SECRET} 사람`, ...attrs });
    cited(hidden, "memo", "비밀 값", secret); // this fact's source hides the item
    const old = cited(hidden, "memo", "지난 값", oldVersion); // stale: only an old version of a public source
    const lint = reads(refuseSecret);

    const reported = lint.report({ rule: "stale", kind: "fact", a: old }, AT);
    expect(reported).toEqual({ status: "not-found" });
    expect(db.all("SELECT count(*) AS n FROM lint_findings")[0]?.n).toBe(0);

    reflect();
    expect(db.all("SELECT rule FROM lint_findings")).toEqual([{ rule: "stale" }]);
    expect(JSON.stringify(lint.list())).not.toContain(SECRET);
    expect(lint.list().findings).toEqual([]);
  });

  it("shows no synonym finding whose group has a member of the refused scope (the lineage conjuncts of the gate)", () => {
    const open = sourceOf("open", "open");
    const secret = sourceOf("secret", "secret");
    const x = insertItem(db, { type: "Project", name: "물결 가", ...attrs });
    const y = insertItem(db, { type: "Project", name: "물결 나", ...attrs });
    const z = insertItem(db, { type: "Project", name: "다른 이름", ...attrs });
    cited(x, "memo", "공개 가", open);
    cited(y, "memo", "공개 나", open);
    cited(y, "alias.name", "물결 가", open); // an alias that is not verified: the synonym rule's case
    cited(z, "memo", "비밀 값", secret);
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [z, x],
    );
    reflect();
    expect(db.all("SELECT rule FROM lint_findings WHERE rule = 'synonym'")).toHaveLength(1);

    expect(
      reads(allowAll)
        .list()
        .findings.filter((f) => f.rule === "synonym"),
    ).toHaveLength(1);
    expect(
      reads(refuseSecret)
        .list()
        .findings.filter((f) => f.rule === "synonym"),
    ).toEqual([]);
  });
});
