// What extraction (V02-T05) reads and writes beside the knowledge tables: the
// version row a job fences, the names linking compares, the versions a
// candidate's name came from (its grade), the dropped counts of a job's result,
// and the release of held jobs when the conditions that blocked them change.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { closeJob, leaseNextJob, readJob, registerJob } from "./jobs.ts";
import {
  findSourceVersionId,
  listItemEvidenceVersions,
  listItemNames,
  readExtractionDrops,
  recordExtractionDrops,
  requeueHeldReasons,
} from "./index.ts";
import { addEvidence, insertItem, saveFact, saveRelation } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(() => db.close());

function stored(externalId: string, body: string): { sourceId: number; version: number } {
  const outcome = saveSourceRecord(db, "c", { externalId, title: "t", body });
  if (outcome.status !== "created") throw new Error("expected a new version");
  return outcome;
}
const versionId = (sourceId: number, version: number) =>
  findSourceVersionId(db, sourceId, version) as number;

describe("findSourceVersionId", () => {
  it("names the row of one source's version, or undefined", () => {
    const one = stored("a", "first");
    const two = stored("a", "second");
    expect(versionId(one.sourceId, 1)).not.toBe(versionId(two.sourceId, 2));
    expect(db.all("SELECT body FROM source_versions WHERE id = ?", [versionId(1, 2)])).toEqual([
      { body: "second" },
    ]);
    expect(findSourceVersionId(db, one.sourceId, 3)).toBeUndefined();
    expect(findSourceVersionId(db, 99, 1)).toBeUndefined();
  });
});

describe("linking reads", () => {
  it("lists every item's id and name", () => {
    const a = insertItem(db, { type: "Project", name: "미리내 프로젝트", ...attrs });
    const b = insertItem(db, { type: "System", name: "물결 API", ...attrs });
    expect(listItemNames(db)).toEqual([
      { id: a, name: "미리내 프로젝트" },
      { id: b, name: "물결 API" },
    ]);
  });

  it("lists the versions behind an item's facts and relations, as subject or object", () => {
    const mail = stored("mail", "A의 목표는 2026-12-05");
    const wiki = stored("wiki", "A는 B에 의존");
    const other = stored("other", "C의 목표는 2026-12-01");
    const a = insertItem(db, { type: "Project", name: "A", ...attrs });
    const b = insertItem(db, { type: "System", name: "B", ...attrs });
    const c = insertItem(db, { type: "Project", name: "C", ...attrs });
    const fact = saveFact(db, { itemId: a, kind: "target_date", value: "2026-12-05", ...attrs });
    addEvidence(db, {
      target: { factId: fact.id },
      sourceVersionId: versionId(mail.sourceId, 1),
      start: 7,
      end: 17,
      quote: "2026-12-05",
    });
    const relation = saveRelation(db, { subjectId: a, type: "DEPENDS_ON", objectId: b, ...attrs });
    addEvidence(db, {
      target: { relationId: relation.id },
      sourceVersionId: versionId(wiki.sourceId, 1),
      start: 0,
      end: 8,
      quote: "A는 B에 의존",
    });
    const cFact = saveFact(db, { itemId: c, kind: "target_date", value: "2026-12-01", ...attrs });
    addEvidence(db, {
      target: { factId: cFact.id },
      sourceVersionId: versionId(other.sourceId, 1),
      start: 7,
      end: 17,
      quote: "2026-12-01",
    });
    expect(listItemEvidenceVersions(db, a)).toEqual([
      versionId(mail.sourceId, 1),
      versionId(wiki.sourceId, 1),
    ]);
    expect(listItemEvidenceVersions(db, b)).toEqual([versionId(wiki.sourceId, 1)]);
    expect(listItemEvidenceVersions(db, 999)).toEqual([]);
  });
});

function leasedJob(externalId: string) {
  const { sourceId, version } = stored(externalId, `body of ${externalId}`);
  // due at the claim's time: a claim honours the run-at time (I03-T03)
  registerJob(db, { kind: "extract", sourceId, fenceVersion: version, at: new Date(0) });
  const job = leaseNextJob(db, { kinds: ["extract"], now: new Date(0), leaseMs: 1000 });
  if (!job) throw new Error("expected a job");
  return job;
}

describe("extraction drops", () => {
  it("records a job's dropped counts and reads them back; a job without any reads undefined", () => {
    const job = leasedJob("a");
    expect(readExtractionDrops(db, job.id)).toBeUndefined();
    closeJob(db, job, {
      status: "succeeded",
      write: () => recordExtractionDrops(db, job.id, { quotes: 2, other: 1 }),
    });
    expect(readExtractionDrops(db, job.id)).toEqual({ quotes: 2, other: 1 });
  });

  it("refuses counts that are not non-negative integers", () => {
    const job = leasedJob("a");
    expect(() => recordExtractionDrops(db, job.id, { quotes: -1, other: 0 })).toThrow(RangeError);
    expect(() => recordExtractionDrops(db, job.id, { quotes: 0.5, other: 0 })).toThrow(RangeError);
    expect(() => recordExtractionDrops(db, 999, { quotes: 0, other: 0 })).toThrow(/not found/);
  });
});

describe("requeueHeldReasons", () => {
  it("puts held jobs of the named reasons back in the queue in their own rows", () => {
    const blocked = leasedJob("a");
    closeJob(db, blocked, { status: "held", reason: "cli-background-off" });
    const large = leasedJob("b");
    closeJob(db, large, { status: "held", reason: "source-too-large" });
    const failed = leasedJob("c");
    closeJob(db, failed, { status: "dead_letter", reason: "invalid-output" });
    const jobs = db.all("SELECT count(*) AS n FROM jobs")[0]?.n;

    expect(requeueHeldReasons(db, { reasons: ["cli-background-off"] })).toBe(1);
    expect(readJob(db, blocked.id)).toMatchObject({ status: "queued", reason: null });
    expect(readJob(db, large.id)).toMatchObject({ status: "held", reason: "source-too-large" });
    expect(readJob(db, failed.id)).toMatchObject({
      status: "dead_letter",
      reason: "invalid-output",
    });
    expect(db.all("SELECT count(*) AS n FROM jobs")[0]?.n).toBe(jobs);

    // claimed again with a raised token, so the old holder still cannot call or close
    const again = leaseNextJob(db, { kinds: ["extract"], now: new Date(0), leaseMs: 1000 });
    expect(again?.id).toBe(blocked.id);
    expect(again?.leaseToken).toBe(blocked.leaseToken + 1);
    expect(requeueHeldReasons(db, { reasons: ["source-too-large"] })).toBe(1);
  });
});
