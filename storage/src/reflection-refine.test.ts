// KGT-C1 (K02-R17, D19): the opinion on a finding is stored only while the finding is open and still has the
// lineage the job was asked at; otherwise nothing is written and the opinion columns stay empty.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { migrate } from "./migrations.ts";
import { insertFinding, readFinding, setFindingStatus } from "./reflection.ts";
import { lineageHash, writeFindingOpinion } from "./reflection-refine.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
});
afterEach(() => db.close());

const AT = "2026-11-24T00:00:00Z";
const lineage = [{ sourceId: 1, version: 1 }];
const OPINION = JSON.stringify({ verdict: "same", sourceId: 1, version: 1, start: 0, end: 1 });

const openSynonym = () =>
  insertFinding(db, {
    rule: "synonym",
    target: { kind: "item", a: 1, b: 2 },
    origin: "rule",
    status: "open",
    lineage,
    at: AT,
  });
const opinionColumns = (id: number) => {
  const f = readFinding(db, id);
  return [f?.opinion, f?.opinionLineageHash];
};

describe("reflection.refine: writeFindingOpinion refuses a stale lineage and a decided finding (KGT-C1)", () => {
  it("writes for an open finding at its present lineage hash", () => {
    const id = openSynonym();
    const hash = lineageHash(lineage);

    expect(db.transaction(() => writeFindingOpinion(db, id, hash, OPINION))).toBe(true);

    expect(opinionColumns(id)).toEqual([OPINION, hash]);
  });

  it("writes nothing when the asked hash is another lineage's", () => {
    const id = openSynonym();
    const other = lineageHash([{ sourceId: 2, version: 1 }]);

    expect(db.transaction(() => writeFindingOpinion(db, id, other, OPINION))).toBe(false);

    expect(opinionColumns(id)).toEqual([null, null]);
  });

  it("writes nothing once the finding is no longer open, even with the right hash", () => {
    const id = openSynonym();
    setFindingStatus(db, id, "dismissed", AT);

    expect(db.transaction(() => writeFindingOpinion(db, id, lineageHash(lineage), OPINION))).toBe(
      false,
    );

    expect(opinionColumns(id)).toEqual([null, null]);
  });
});
