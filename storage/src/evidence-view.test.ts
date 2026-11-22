// V02-R14 evidence views (spec "T10이 넘기는 것" 2): an Insight's evidence says
// whether its version is the source's latest, and the source view reads the version
// the evidence points to while naming the latest. Only active Insights are listed.
import { EvidenceViewSchema, type NativeLocator } from "@pki/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { listActiveInsights, readEvidenceSource, readInsightEvidence } from "./evidence-view.ts";
import { saveInsight } from "./insights.ts";
import { addEvidence, insertItem, saveFact, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

function version(body: string): number {
  saveSourceRecord(db, "c1", { externalId: "s1", title: "합성 제목", body });
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}

/** An active Insight whose one evidence quotes "12월" in version 1 of source s1. */
function seed() {
  const v1 = version("🙂 기한은 12월");
  const x = insertItem(db, { ...attrs, type: "Project", name: "X" });
  const y = insertItem(db, { ...attrs, type: "System", name: "Y" });
  const fact = saveFact(db, { ...attrs, itemId: x, kind: "target_date", value: "2026-12-05" });
  const evidenceId = addEvidence(db, {
    target: { factId: fact.id },
    sourceVersionId: v1,
    start: 6,
    end: 9,
    quote: "12월",
  });
  const key = { rule: "dependency_delay", xItemId: x, yItemId: y };
  saveInsight(db, key, { state: "active", summary: "위험(추론)", evidenceIds: [evidenceId] });
  const insightId = listActiveInsights(db)[0]?.id as number;
  return { v1, evidenceId, insightId, key };
}

describe("evidence views", () => {
  it("marks evidence on an older version as not current, and opens that version", () => {
    const { v1, evidenceId, insightId } = seed();
    expect(readInsightEvidence(db, insightId)?.evidence[0]).toMatchObject({
      id: evidenceId,
      version: 1,
      current: true,
    });
    version("🙂 기한은 1월");
    expect(readInsightEvidence(db, insightId)?.evidence[0]).toMatchObject({
      version: 1,
      current: false,
    });
    expect(readEvidenceSource(db, evidenceId)).toEqual({
      evidenceId,
      quote: "12월",
      start: 6,
      end: 9,
      locator: null,
      sourceVersion: {
        id: v1,
        version: 1,
        latestVersion: 2,
        title: "합성 제목",
        body: "🙂 기한은 12월",
      },
    });
  });

  it("lists and opens only active Insights", () => {
    const { insightId, key } = seed();
    expect(listActiveInsights(db)).toEqual([
      { id: insightId, epistemic: "inferred", summary: "위험(추론)", evidenceCount: 1 },
    ]);
    saveInsight(db, key, { state: "resolved" });
    expect(listActiveInsights(db)).toEqual([]);
    expect(readInsightEvidence(db, insightId)).toBeUndefined();
  });

  it("finds no source for evidence that does not exist", () => {
    expect(readEvidenceSource(db, 42)).toBeUndefined();
  });
});

// I01-R29 (spec "T07이 넘기는 것"): the locator is computed on read from the blocks
// of the version the evidence points to: the block holding the span's start.
describe("evidence locator (I01-R29)", () => {
  // a body of 20 code points: an emoji first, so UTF-16 offsets would be off by one
  const BODY = "🙂abcdefghijklmnopqrs";
  const LOCATORS: NativeLocator[] = [
    { format: "pdf", page: 3 },
    { format: "docx", paragraph: 4, style: "Heading1", headingLevel: 1 },
    { format: "xlsx", sheet: "요약", cell: "B7" },
    { format: "csv", record: 2, line: 3, field: 1 },
    { format: "html", path: "html>body>p", line: 5 },
    { format: "markdown", line: 9, node: "paragraph" },
    { format: "txt", line: 2 },
    { format: "json", line: 1 },
  ];

  function seedEvidence(
    body: string,
    blocks: unknown[] | undefined,
    span: { start: number; end: number },
    externalId = "s1",
  ): { evidenceId: number; versionId: number } {
    saveSourceRecord(db, "c1", { externalId, title: "합성 제목", body, blocks });
    const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    const x = insertItem(db, { ...attrs, type: "Project", name: `X${externalId}` });
    const fact = saveFact(db, { ...attrs, itemId: x, kind: "target_date", value: "2026-12-05" });
    const evidenceId = addEvidence(db, {
      target: { factId: fact.id },
      sourceVersionId: versionId,
      ...span,
      quote: Array.from(body).slice(span.start, span.end).join(""),
    });
    return { evidenceId, versionId };
  }

  it.each(LOCATORS.map((locator) => [locator.format, locator] as const))(
    "returns the %s locator of the block holding the span start",
    (_format, locator) => {
      const { evidenceId } = seedEvidence(
        BODY,
        [
          { start: 0, end: 5, locator: { format: "txt", line: 1 } },
          { start: 5, end: 20, locator },
        ],
        { start: 8, end: 11 },
      );
      expect(readEvidenceSource(db, evidenceId)?.locator).toEqual(locator);
    },
  );

  it("is null for a version without blocks", () => {
    const { evidenceId } = seedEvidence(BODY, undefined, { start: 1, end: 4 });
    expect(readEvidenceSource(db, evidenceId)?.locator).toBeNull();
  });

  it("is null when the span start falls in a gap between blocks", () => {
    const { evidenceId } = seedEvidence(
      BODY,
      [
        { start: 0, end: 3, locator: { format: "pdf", page: 1 } },
        { start: 10, end: 20, locator: { format: "pdf", page: 2 } },
      ],
      { start: 5, end: 12 },
    );
    expect(readEvidenceSource(db, evidenceId)?.locator).toBeNull();
  });

  it("uses the block holding the start even when the span runs into the next block", () => {
    const { evidenceId } = seedEvidence(
      BODY,
      [
        { start: 0, end: 6, locator: { format: "pdf", page: 1 } },
        { start: 6, end: 20, locator: { format: "pdf", page: 2 } },
      ],
      { start: 4, end: 9 },
    );
    expect(readEvidenceSource(db, evidenceId)?.locator).toEqual({ format: "pdf", page: 1 });
  });

  it("counts code points: an astral character before the boundary is one unit", () => {
    // UTF-16 offsets of this body run one ahead after the emoji, so a UTF-16 start of 1
    // (code point 1) would read as 2 and land in the second block
    const blocks = [
      { start: 0, end: 2, locator: { format: "pdf", page: 1 } },
      { start: 2, end: 20, locator: { format: "pdf", page: 2 } },
    ];
    const inFirst = seedEvidence(BODY, blocks, { start: 1, end: 2 }, "a");
    const inSecond = seedEvidence(BODY, blocks, { start: 2, end: 3 }, "b");
    expect(readEvidenceSource(db, inFirst.evidenceId)?.locator).toEqual({ format: "pdf", page: 1 });
    expect(readEvidenceSource(db, inSecond.evidenceId)?.locator).toEqual({
      format: "pdf",
      page: 2,
    });
  });

  it("keeps computing a past evidence's locator from the version it points to", () => {
    const { evidenceId, versionId } = seedEvidence(
      BODY,
      [{ start: 0, end: 20, locator: { format: "pdf", page: 1 } }],
      { start: 2, end: 5 },
    );
    saveSourceRecord(db, "c1", {
      externalId: "s1",
      title: "합성 제목",
      body: `새 머리말 ${BODY}`,
      blocks: [{ start: 0, end: 30, locator: { format: "pdf", page: 9 } }],
    });
    const view = readEvidenceSource(db, evidenceId);
    expect(view?.sourceVersion).toMatchObject({ id: versionId, version: 1, latestVersion: 2 });
    expect(view?.locator).toEqual({ format: "pdf", page: 1 });
  });

  it("keeps a past evidence's own version locator on the Insight list path too", () => {
    const { evidenceId } = seedEvidence(
      BODY,
      [{ start: 0, end: 20, locator: { format: "pdf", page: 1 } }],
      { start: 2, end: 5 },
    );
    const y = insertItem(db, { ...attrs, type: "System", name: "Y" });
    const x = db.all("SELECT id FROM items LIMIT 1")[0]?.id as number;
    saveInsight(
      db,
      { rule: "dependency_delay", xItemId: x, yItemId: y },
      { state: "active", summary: "위험(추론)", evidenceIds: [evidenceId] },
    );
    saveSourceRecord(db, "c1", {
      externalId: "s1",
      title: "합성 제목",
      body: `새 머리말 ${BODY}`,
      blocks: [{ start: 0, end: 30, locator: { format: "pdf", page: 9 } }],
    });
    const insightId = listActiveInsights(db)[0]?.id as number;
    expect(readInsightEvidence(db, insightId)?.evidence[0]).toMatchObject({
      version: 1,
      current: false,
      locator: { format: "pdf", page: 1 },
    });
  });

  it("answers in the shape of EvidenceView (I01-R29)", () => {
    const { evidenceId, versionId } = seedEvidence(
      BODY,
      [{ start: 0, end: 20, locator: { format: "pdf", page: 1 } }],
      { start: 2, end: 5 },
    );
    const read = readEvidenceSource(db, evidenceId);
    expect(read).toBeDefined();
    const { sourceVersion, start, end, quote, locator } = read as NonNullable<typeof read>;
    expect(
      EvidenceViewSchema.parse({
        sourceVersionId: sourceVersion.id,
        version: sourceVersion.version,
        span: { start, end },
        quote,
        locator,
      }),
    ).toMatchObject({ sourceVersionId: versionId, version: 1, span: { start: 2, end: 5 } });
  });

  it("is on each row of an Insight's evidence list too", () => {
    const { evidenceId } = seedEvidence(
      BODY,
      [{ start: 0, end: 20, locator: { format: "xlsx", sheet: "요약", cell: "B7" } }],
      { start: 2, end: 5 },
    );
    const y = insertItem(db, { ...attrs, type: "System", name: "Y" });
    const x = db.all("SELECT id FROM items LIMIT 1")[0]?.id as number;
    saveInsight(
      db,
      { rule: "dependency_delay", xItemId: x, yItemId: y },
      { state: "active", summary: "위험(추론)", evidenceIds: [evidenceId] },
    );
    const insightId = listActiveInsights(db)[0]?.id as number;
    expect(readInsightEvidence(db, insightId)?.evidence[0]?.locator).toEqual({
      format: "xlsx",
      sheet: "요약",
      cell: "B7",
    });
  });
});
