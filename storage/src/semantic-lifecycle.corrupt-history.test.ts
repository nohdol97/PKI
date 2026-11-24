// RFU-C1 (RFU-R1): a hand-edited history whose newest cancellation names a line number that is not
// below its own makes the reading functions end with "no line to point at", never loop. The gate
// never writes such a line, so the rows below are forged with plain INSERTs.
import { memoryDbTemplate } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { insertItem, saveFact, type KnowledgeStatus } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { applyTransition, automatedLifecycle, type EntryRef } from "./semantic-lifecycle.ts";
import { registerConnectorInstance } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

/** A fact inserted at `status` whose only history line is an `undo` naming line 5 (its own number is 1). */
function factWithForwardUndo(status: KnowledgeStatus): EntryRef {
  const attrs = {
    epistemic: "explicit",
    status,
    validAt: null,
    observedAt: "2026-11-21T00:00:00Z",
  } as const;
  const owner = insertItem(db, { type: "p", name: "item", ...attrs });
  const id = saveFact(db, { itemId: owner, kind: "k", value: "v", ...attrs }).id;
  db.run(
    `INSERT INTO fact_history (fact_id, seq, at, actor, action, from_status, to_status,
       from_epistemic, to_epistemic, reverts_seq)
     VALUES (?, 1, '2026-11-22T00:00:00Z', 'user', 'undo', 'candidate', ?, 'explicit', 'explicit', 5)`,
    [id, status],
  );
  return { kind: "fact", id };
}
const historyLength = (ref: EntryRef) =>
  db.all("SELECT count(*) AS n FROM fact_history WHERE fact_id = ?", [ref.id])[0]?.n;

describe("a cancellation line naming a later line", () => {
  it("evidence returning on a superseded fact is refused and writes no line (stateMaker ends)", () => {
    const ref = factWithForwardUndo("superseded");
    expect(automatedLifecycle.evidenceReturned(db, ref, { sourceId: 7, version: 3 })).toEqual({
      status: "refused",
      reason: "invalid-transition",
    });
    expect(historyLength(ref)).toBe(1);
  });

  it("a user approval of a verified fact finds no policy line and changes nothing (policyVerifiedLine ends)", () => {
    const ref = factWithForwardUndo("verified");
    expect(applyTransition(db, ref, "user", "verified")).toEqual({ status: "unchanged" });
    expect(historyLength(ref)).toBe(1);
  });
});
