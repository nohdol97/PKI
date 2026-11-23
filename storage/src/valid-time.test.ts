// S02-T08 `time.valid-observed` (S02-R17, C3): the valid interval and the observed time are two columns, the
// user's fix writes one history line without dates, and an extraction fills only an empty interval.
// All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { createEntityDecisions } from "./entity-decisions.ts";
import { insertItem, readFact, saveFact, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { automatedLifecycle } from "./semantic-lifecycle.ts";
import { userDecisions } from "./semantic-user.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { fillValidity, validitySetByUser } from "./valid-time.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
});
afterEach(() => db.close());

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
function fact(over: Partial<KnowledgeAttributes> = {}) {
  const itemId = insertItem(db, { type: "Project", name: "p", ...attrs });
  const saved = saveFact(db, {
    itemId,
    kind: "target_date",
    value: "2026-12-05",
    ...attrs,
    ...over,
  });
  const ref = { kind: "fact", id: saved.id } as const;
  automatedLifecycle.created(db, ref, "extraction", null);
  return ref;
}
const entities = createEntityDecisions({
  combinable: () => true,
  listeners: [],
  createItem: () => 0,
});
const lines = (id: number) =>
  db.all("SELECT actor, action, reason FROM fact_history WHERE fact_id = ? ORDER BY seq", [id]);

describe("time.valid-observed (S02-R17)", () => {
  it("setValidity writes both ends, leaves observed_at, writes one set-validity line without dates and returns the previous interval", () => {
    const ref = fact({ validAt: "2026-01-01" });
    const first = entities.setValidity(db, ref, "2026-02-01", "2026-03-01");
    expect(first).toMatchObject({
      status: "applied",
      previous: { from: "2026-01-01", until: null },
    });
    expect(readFact(db, ref.id)).toMatchObject({
      validAt: "2026-02-01",
      validUntil: "2026-03-01",
      observedAt: attrs.observedAt,
    });
    expect(lines(ref.id).at(-1)).toEqual({ actor: "user", action: "set-validity", reason: null });
    expect(JSON.stringify(db.all("SELECT * FROM fact_history"))).not.toContain("2026-03-01");
    const second = entities.setValidity(db, ref, null, null);
    expect(second).toMatchObject({ previous: { from: "2026-02-01", until: "2026-03-01" } });
    expect(entities.setValidity(db, { kind: "fact", id: 9999 }, null, null)).toEqual({
      status: "refused",
      reason: "not-found",
    });
  });

  it("an approval's undo reads past the validity line: the approval is reverted, the interval stays", () => {
    const ref = fact();
    expect(userDecisions.decide(db, ref, "approve")).toMatchObject({ status: "applied" });
    entities.setValidity(db, ref, "2026-02-01", "2026-03-01");
    expect(userDecisions.undo(db, ref)).toMatchObject({ status: "applied" });
    expect(readFact(db, ref.id)).toMatchObject({
      status: "candidate",
      validAt: "2026-02-01",
      validUntil: "2026-03-01",
    });
  });

  it("fillValidity fills only a row whose two ends are empty and whose interval the user never set", () => {
    const empty = fact();
    expect(fillValidity(db, empty, "2026-02-01", "2026-03-01")).toBe(true);
    expect(fillValidity(db, empty, "2027-01-01", "2027-02-01")).toBe(false);
    expect(readFact(db, empty.id)).toMatchObject({
      validAt: "2026-02-01",
      validUntil: "2026-03-01",
    });
    // the user cleared it: both ends empty again, but the fix is theirs
    const cleared = fact();
    entities.setValidity(db, cleared, null, null);
    expect(validitySetByUser(db, cleared)).toBe(true);
    expect(fillValidity(db, cleared, "2026-02-01", "2026-03-01")).toBe(false);
  });
});
