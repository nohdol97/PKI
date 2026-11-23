// K02-R17: the list carries the verdict of a stored LLM opinion beside its finding, and nothing of its position;
// a finding without an opinion has no `opinion` field.
import { createProductRegistry, planReflect } from "@pki/knowledge-engine";
import {
  addEvidence,
  commitDerived,
  defaultScopePolicy,
  insertItem,
  lineageHash,
  lineageOfFinding,
  migrate,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  userDecisions,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLintReads } from "./lint-read.ts";
import { createReadGate } from "./read-gate.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

describe("lint.opinion: the list shows the LLM verdict (K02-R17)", () => {
  it("gives the verdict alone when an opinion is stored, and no field without one", () => {
    const body = "업무 본문";
    saveSourceRecord(db, "c1", { externalId: "a", title: "제목", body });
    const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    const itemId = insertItem(db, {
      type: "Task",
      name: "업무",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    });
    const factId = saveFact(db, {
      itemId,
      kind: "target_date",
      value: "2026-01-15",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    }).id;
    addEvidence(db, {
      target: { factId },
      sourceVersionId: versionId,
      start: 0,
      end: [...body].length,
      quote: body,
    });
    const plan = planReflect(db, "daily", "2026-11-23T00:00:00.000Z", {});
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
    const registry = createProductRegistry({ policy: defaultScopePolicy });
    const lint = createLintReads(
      db,
      registry,
      createReadGate(db, registry),
      () => userDecisions,
      () => undefined,
    );
    expect(lint.list().findings[0]).not.toHaveProperty("opinion");

    const hash = lineageHash(
      lineageOfFinding(db, db.all("SELECT id FROM lint_findings")[0]?.id as number),
    );
    db.run("UPDATE lint_findings SET opinion = ?, opinion_lineage_hash = ?", [
      JSON.stringify({ verdict: "related", sourceId: 1, version: 1, start: 0, end: 2 }),
      hash,
    ]);
    const shown = lint.list().findings[0];
    expect(shown?.opinion).toBe("related");
    expect(JSON.stringify(shown)).not.toContain("start");

    // an opinion asked at another lineage than the finding has now is not shown (K02-D19)
    db.run("UPDATE lint_findings SET opinion_lineage_hash = 'other'");
    expect(lint.list().findings[0]).not.toHaveProperty("opinion");
  });
});
