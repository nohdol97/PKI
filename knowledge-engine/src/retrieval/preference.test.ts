// X01-C5a (R19) the item preference lifts a source's rank when `feedback.learned` is on and nothing else changes;
// X01-C5b (R19, R12, negative test, mutation target) an item the read gate hides for a search moves no hit.
// The data is synthetic; the ranks are read from a base run, never assumed.
import {
  addEvidence,
  defaultScopePolicy,
  FEEDBACK_LEARNED_SETTING,
  insertItem,
  migrate,
  recordFeedback,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  userDecisions,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { describe, expect, it } from "vitest";
import { createProductRegistry } from "../canonical-kinds.ts";
import { feedbackPreference } from "./preference.ts";
import { retrieve } from "./index.ts";

const registry = createProductRegistry({ policy: defaultScopePolicy });
const attrs = {
  epistemic: "explicit",
  status: "verified",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;
const TABLES = ["items", "facts", "relations", "evidence", "feedback"];

/** Six sources with the probe word; an item with a fact resting on the 3rd-ranked one. Feedback is not yet recorded. */
async function plant(reg: typeof registry = registry) {
  const db: SqlDriver = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  for (let i = 0; i < 6; i++)
    saveSourceRecord(db, "c1", {
      externalId: `e${i}`,
      title: `t${i}`,
      body: `프로브낱말 표식${i}`,
      accessScope: ["open"],
    });
  const before = await retrieve(db, reg, "프로브낱말");
  const target = before.hits[2]?.versionId as number;
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [target])[0]?.body as string;
  const item = insertItem(db, { type: "Project", name: "선호항목", ...attrs });
  const factId = saveFact(db, { itemId: item, kind: "memo", value: "값", ...attrs }).id;
  addEvidence(db, {
    target: { factId },
    sourceVersionId: target,
    start: 0,
    end: [...body].length,
    quote: body,
  });
  // the base is taken after the item exists (the hit's `related` changes with it) and before the feedback
  const base = await retrieve(db, reg, "프로브낱말");
  recordFeedback(
    db,
    userDecisions,
    { target: { kind: "item", id: item }, kind: "important" },
    "2026-11-23T00:00:00.000Z",
  );
  const counts = () => TABLES.map((t) => db.all(`SELECT count(*) AS n FROM ${t}`)[0]?.n);
  return { db, target, item, base, counts };
}

describe("X01-C5a the item preference lifts the source it rests on", () => {
  it("moves the 3rd hit to 1st when the setting is on, changes only the order, and does nothing when it is off", async () => {
    const w = await plant();
    const off = await retrieve(
      w.db,
      registry,
      "프로브낱말",
      {},
      { preference: feedbackPreference(w.db, registry) },
    );
    expect(off.hits).toEqual(w.base.hits);

    writeSetting(w.db, FEEDBACK_LEARNED_SETTING, "on");
    const rowsBefore = w.counts();
    const on = await retrieve(
      w.db,
      registry,
      "프로브낱말",
      {},
      { preference: feedbackPreference(w.db, registry) },
    );
    expect(on.hits[0]?.versionId).toBe(w.target);
    expect(on.hits.map((h) => h.versionId).sort()).toEqual(
      w.base.hits.map((h) => h.versionId).sort(),
    );
    expect(w.counts()).toEqual(rowsBefore);
    w.db.close();
  });
});

describe("X01-C5b a hidden item's preference moves no hit", () => {
  it("leaves the hits as they were before the feedback when the read gate hides the item for a search", async () => {
    // the one item of the world is hidden for a search from the start, so the base run is taken with it hidden
    const hiding: typeof registry = {
      ...registry,
      visible: (db, refs, purpose) =>
        registry
          .visible(db, refs, purpose)
          .filter((r) => !(purpose === "search" && r.kind === "item")),
    };
    const w = await plant(hiding);
    writeSetting(w.db, FEEDBACK_LEARNED_SETTING, "on");
    const found = await retrieve(
      w.db,
      hiding,
      "프로브낱말",
      {},
      { preference: feedbackPreference(w.db, hiding) },
    );
    expect(found.hits).toEqual(w.base.hits);
    w.db.close();
  });
});
