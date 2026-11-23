// RVS-R6: one row per (source version, item) pair, in id order, however many facts the pair rests on.
import {
  addEvidence,
  defaultScopePolicy,
  insertItem,
  migrate,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { describe, expect, it } from "vitest";
import { createProductRegistry } from "../canonical-kinds.ts";
import { createJudge } from "../graph-read.ts";
import { shownItemsEvidencedBy } from "./evidenced.ts";

describe("shownItemsEvidencedBy", () => {
  it("lists a pair once when two facts of the item rest on the same version", () => {
    const registry = createProductRegistry({ policy: defaultScopePolicy });
    const db: SqlDriver = openBetterSqlite3(":memory:");
    migrate(db);
    registerConnectorInstance(db, "c1", "test-fixtures");
    saveSourceRecord(db, "c1", { externalId: "e", title: "t", body: "근거문장" });
    const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    const attrs = {
      epistemic: "explicit",
      status: "verified",
      observedAt: "2026-11-21T00:00:00Z",
      validAt: null,
    } as const;
    const itemId = insertItem(db, { type: "Project", name: "항목", ...attrs });
    for (const value of ["하나", "둘"]) {
      const factId = saveFact(db, { itemId, kind: "memo", value, ...attrs }).id;
      addEvidence(db, {
        target: { factId },
        sourceVersionId: versionId,
        start: 0,
        end: 4,
        quote: "근거문장",
      });
    }
    const judge = createJudge(db, registry, "search", false);
    expect(shownItemsEvidencedBy(db, judge, [versionId])).toEqual([{ versionId, itemId }]);
  });
});
