// A new source version's propagation (V02-R11): the rows its previous version
// alone supported become superseded, their evidence stays past evidence on that
// version, and the Insights over their items are recomputed in the same call.
import {
  addEvidence,
  insertItem,
  listEvidence,
  migrate,
  readInsight,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  recomputeDependencyDelay,
} from "./dependency-delay.ts";
import { propagateNewVersion } from "./propagation.ts";

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

let db: SqlDriver;
let x: number;
let y: number;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  x = insertItem(db, { type: "Project", name: "미리내 프로젝트", ...attrs });
  y = insertItem(db, { type: "System", name: "물결 API", ...attrs });
});
afterEach(() => {
  db.close();
});

/** Stores `body` as the next version of `externalId`; returns its source id and row id. */
function version(externalId: string, body: string) {
  const saved = saveSourceRecord(db, "c1", { externalId, title: externalId, body });
  if (saved.status !== "created") throw new Error(saved.status);
  const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { sourceId: saved.sourceId, id };
}
const cite = (target: { factId: number } | { relationId: number }, sv: number, body: string) =>
  addEvidence(db, { target, sourceVersionId: sv, start: 0, end: [...body].length, quote: body });

/** X targets 12-05 (mail), X depends on Y (wiki), Y completes 12-10 (chat): one active Insight. */
function lateDependency() {
  const target = saveFact(db, { itemId: x, kind: TARGET_DATE, value: "2026-12-05", ...attrs }).id;
  cite({ factId: target }, version("mail", "목표 12-05").id, "목표 12-05");
  const relation = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs }).id;
  cite({ relationId: relation }, version("wiki", "X는 Y에 의존").id, "X는 Y에 의존");
  const late = saveFact(db, { itemId: y, kind: COMPLETION_DATE, value: "2026-12-10", ...attrs }).id;
  const chat = version("chat", "완료 12-10");
  const old = cite({ factId: late }, chat.id, "완료 12-10");
  recomputeDependencyDelay(db, [x, y]);
  return { late, chat, old };
}
const key = () => ({ rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y });

describe("propagateNewVersion", () => {
  it("supersedes what only the previous version supported and resolves its Insight in the same row", () => {
    const { late, chat, old } = lateDependency();
    const before = readInsight(db, key());
    expect(before?.state).toBe("active");

    version("chat", "완료 12-03");
    expect(propagateNewVersion(db, chat.sourceId)).toEqual({
      facts: [late],
      relations: [],
      insights: [{ key: key(), outcome: "resolved" }],
    });
    expect(readInsight(db, key())).toMatchObject({
      id: before?.id,
      state: "resolved",
      summary: null,
      evidenceIds: [],
    });
    expect(listEvidence(db, { factId: late })).toEqual([
      expect.objectContaining({ id: old, sourceVersionId: chat.id, current: false }),
    ]);
  });

  it("keeps a row another source still supports and moves the Insight onto current evidence only", () => {
    const { late, chat, old } = lateDependency();
    const echo = cite({ factId: late }, version("echo", "완료 12-10").id, "완료 12-10");
    recomputeDependencyDelay(db, [y]);
    expect(readInsight(db, key())?.evidenceIds).toContain(old);

    version("chat", "완료 12-03");
    expect(propagateNewVersion(db, chat.sourceId)).toEqual({
      facts: [],
      relations: [],
      insights: [{ key: key(), outcome: "updated" }],
    });
    const insight = readInsight(db, key());
    expect(insight?.state).toBe("active");
    expect(insight?.evidenceIds).toContain(echo);
    expect(insight?.evidenceIds).not.toContain(old);
  });

  it("changes nothing for a source none of whose evidence is past", () => {
    lateDependency();
    const fresh = version("new", "무관한 글");
    const changes = db.all("SELECT total_changes() AS n")[0]?.n;
    expect(propagateNewVersion(db, fresh.sourceId)).toEqual({
      facts: [],
      relations: [],
      insights: [],
    });
    expect(db.all("SELECT total_changes() AS n")[0]?.n).toBe(changes);
  });
});
