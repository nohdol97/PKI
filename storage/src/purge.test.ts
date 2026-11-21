// V02-R12 storage part of a source's purge ("T02가 넘기는 것" 5): every version of
// the source goes with its evidence and keyword index rows; of the facts,
// relations and items its evidence reached (collected before deleting), those
// left without evidence, or items without facts and relations, are deleted;
// everything else, an unrelated item without knowledge included, stays.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { saveInsight } from "./insights.ts";
import {
  addEvidence,
  insertItem,
  saveFact,
  saveRelation,
  setKnowledgeStatus,
  type EvidenceTarget,
  type KnowledgeAttributes,
} from "./knowledge.ts";
import { searchKeyword } from "./keyword-search.ts";
import { migrate, migrations } from "./migrations.ts";
import { purgeSourceContent } from "./purge.ts";
import { readChangeSeq } from "./revisions.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;
const ids = (table: string) => db.all(`SELECT id FROM ${table} ORDER BY id`).map((r) => r.id);

/** Stores a version of `externalId` and returns [source id, version row id]. */
function version(externalId: string, body: string): [number, number] {
  const saved = saveSourceRecord(db, "c1", { externalId, title: `제목 ${externalId}`, body });
  if (saved.status !== "created") throw new Error(saved.status);
  const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return [saved.sourceId, id];
}

/** Evidence for `target` quoting the whole body of version `versionId`. */
function cite(target: EvidenceTarget, versionId: number): number {
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [versionId])[0]
    ?.body as string;
  return addEvidence(db, {
    target,
    sourceVersionId: versionId,
    start: 0,
    end: [...body].length,
    quote: body,
  });
}

const item = (name: string) => insertItem(db, { type: "Project", name, ...attrs });
const fact = (itemId: number, value: string) =>
  saveFact(db, { itemId, kind: "target_date", value, ...attrs }).id;
const relation = (subjectId: number, objectId: number) =>
  saveRelation(db, { subjectId, type: "DEPENDS_ON", objectId, ...attrs }).id;

describe("purgeSourceContent", () => {
  it("deletes every version of the source, its evidence and its keyword index rows", () => {
    const [a, a1] = version("a", "첫 판 qzvold");
    const [, a2] = version("a", "둘째 판 jwxnew");
    const [, b1] = version("b", "다른 원본");
    const x = item("X");
    cite({ factId: fact(x, "2026-12-05") }, a1);
    cite({ factId: fact(x, "2026-12-06") }, a2);
    cite({ factId: fact(x, "2026-12-07") }, b1);
    const seq = readChangeSeq(db);

    const result = purgeSourceContent(db, a);

    expect(result.versions).toBe(2);
    expect(db.all("SELECT source_id FROM source_versions")).toEqual([{ source_id: 2 }]);
    expect(db.all("SELECT source_version_id FROM evidence")).toEqual([{ source_version_id: b1 }]);
    expect(searchKeyword(db, "qzvold")).toEqual([]);
    expect(searchKeyword(db, "jwxnew")).toEqual([]);
    expect(searchKeyword(db, "다른")).toHaveLength(1);
    // the sources row (identifier only) stays for the tombstone; deleting raises no sequence
    expect(count("sources")).toBe(2);
    expect(readChangeSeq(db)).toBe(seq);
    expect(a2).toBeGreaterThan(a1);
  });

  it("deletes the facts and relations it left without evidence, superseded ones included", () => {
    const [a, a1] = version("a", "v1");
    const [, a2] = version("a", "v2");
    const [, b1] = version("b", "b");
    const [x, y, z] = [item("X"), item("Y"), item("Z")];
    const old = fact(x, "2026-12-10");
    cite({ factId: old }, a1);
    setKnowledgeStatus(db, "fact", old, "superseded");
    const current = fact(x, "2026-12-12");
    cite({ factId: current }, a2);
    const shared = fact(y, "2026-12-05");
    cite({ factId: shared }, a2);
    cite({ factId: shared }, b1);
    const dependsOn = relation(x, y);
    cite({ relationId: dependsOn }, a1);
    const kept = relation(y, z);
    cite({ relationId: kept }, b1);

    const result = purgeSourceContent(db, a);

    expect(result.facts).toEqual([old, current]);
    expect(result.relations).toEqual([dependsOn]);
    expect(ids("facts")).toEqual([shared]);
    expect(ids("relations")).toEqual([kept]);
    expect(db.all("SELECT count(*) AS n FROM evidence WHERE fact_id = ?", [shared])).toEqual([
      { n: 1 },
    ]);
  });

  it("deletes only collected items left without facts and relations, never an unrelated one", () => {
    const [a, a1] = version("a", "a");
    const [, b1] = version("b", "b");
    const [x, y, keptByB, unrelated] = [item("X"), item("Y"), item("K"), item("U")];
    cite({ factId: fact(x, "2026-12-05") }, a1);
    cite({ relationId: relation(x, y) }, a1);
    cite({ factId: fact(keptByB, "2026-12-01") }, b1);
    cite({ relationId: relation(keptByB, y) }, a1);
    // an Insight on X (deleted) and one on K and Y (both stay)
    saveInsight(db, { rule: "r", xItemId: x, yItemId: y }, { state: "resolved" });
    saveInsight(db, { rule: "r", xItemId: keptByB, yItemId: y }, { state: "resolved" });

    const result = purgeSourceContent(db, a);

    expect(result.items).toEqual([x, y]);
    expect(result.remainingItemIds).toEqual([keptByB]);
    expect(ids("items")).toEqual([keptByB, unrelated]);
    expect(db.all("SELECT x_item_id, y_item_id FROM insights")).toEqual([]);
  });

  it("keeps an item another source's relation still points at", () => {
    const [a, a1] = version("a", "a");
    const [, b1] = version("b", "b");
    const [x, y] = [item("X"), item("Y")];
    cite({ factId: fact(y, "2026-12-10") }, a1);
    cite({ relationId: relation(x, y) }, b1);
    saveInsight(
      db,
      { rule: "r", xItemId: x, yItemId: y },
      { state: "active", summary: "추론", evidenceIds: [] },
    );

    const result = purgeSourceContent(db, a);

    expect(result.items).toEqual([]);
    expect(result.remainingItemIds).toEqual([y]);
    expect(ids("items")).toEqual([x, y]);
    expect(count("insights")).toBe(1);
  });

  it("does nothing to a source without versions", () => {
    const [a] = version("a", "a");
    purgeSourceContent(db, a);
    expect(purgeSourceContent(db, a)).toEqual({
      versions: 0,
      facts: [],
      relations: [],
      items: [],
      remainingItemIds: [],
    });
  });
});

describe("purgeSourceContent on a database upgraded from v8", () => {
  it("leaves no word of a version indexed before the upgrade in the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pki-purge-"));
    const file = join(dir, "upgraded.sqlite");
    const old = openBetterSqlite3(file);
    try {
      migrate(old, migrations.slice(0, 8));
      registerConnectorInstance(old, "c1", "test-fixtures");
      const saved = saveSourceRecord(old, "c1", {
        externalId: "a",
        title: "zkqtitle",
        body: "합성 vbnbody",
      });
      if (saved.status !== "created") throw new Error(saved.status);
      expect(readFileSync(file).includes("vbnbody")).toBe(true);
      migrate(old);
      purgeSourceContent(old, saved.sourceId);
      const bytes = readFileSync(file);
      expect(["zkqtitle", "vbnbody"].filter((c) => bytes.includes(c))).toEqual([]);
    } finally {
      old.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
