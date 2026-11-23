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
