// X01-C6a ② `keywordIds` reads in pages: the pages are admitted (visibility, conditions) before the cut, and the
// read stops at the page limit (X01-D19). The paging is a parameter so two pages of two stand in for 5 of 100.
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
import { shownVersions } from "./notes.ts";
import { keywordIds, temporalIds } from "./strategies.ts";

const registry = createProductRegistry({
  policy: { ...defaultScopePolicy, allows: (scopes) => !scopes.some((s) => s?.includes("denied")) },
});

function plant(denied: number) {
  const db: SqlDriver = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  const add = (mark: string, scope: string[], body: string) =>
    saveSourceRecord(db, "c1", { externalId: mark, title: mark, body, accessScope: scope });
  for (let i = 0; i < denied; i++)
    add(`denied-${i}`, ["denied"], "프로브낱말 프로브낱말 프로브낱말");
  add("open", ["open"], "프로브낱말");
  const openId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const reading = {
    db,
    registry,
    judge: createJudge(db, registry, "search", false),
    question: "프로브낱말",
  };
  const admit = (ids: readonly number[]) => {
    const shown = shownVersions(db, registry, ids);
    return ids.filter((id) => shown.has(id));
  };
  return { reading, admit, openId };
}

describe("X01-C6a ② keywordIds pages", () => {
  const paging = { size: 2, pages: 2 };
  it("reaches a visible source behind 3 hidden ones and stops at the page limit behind 4", () => {
    const three = plant(3);
    expect(keywordIds(three.reading, [], three.admit, paging)).toEqual([three.openId]);
    const four = plant(4);
    expect(keywordIds(four.reading, [], four.admit, paging)).toEqual([]);
  });
});

describe("RSP-C1 temporalIds pages the dated facts and filters before the cut", () => {
  it("reaches a visible older fact behind 210 newer facts the search hides", async () => {
    const db: SqlDriver = openBetterSqlite3(":memory:");
    migrate(db);
    registerConnectorInstance(db, "c1", "test-fixtures");
    saveSourceRecord(db, "c1", {
      externalId: "e",
      title: "t",
      body: "근거문장",
      accessScope: ["open"],
    });
    const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    const attrs = {
      epistemic: "explicit",
      status: "verified",
      observedAt: "2026-11-21T00:00:00Z",
    } as const;
    const item = insertItem(db, { type: "Project", name: "항목", ...attrs, validAt: null });
    const hidden = new Set<string>();
    for (let i = 0; i < 210; i++)
      hidden.add(
        String(
          saveFact(db, {
            itemId: item,
            kind: "memo",
            value: `새${i}`,
            ...attrs,
            validAt: "2026-06-01",
          }).id,
        ),
      );
    const old = saveFact(db, {
      itemId: item,
      kind: "memo",
      value: "옛",
      ...attrs,
      validAt: "2020-01-01",
    }).id;
    addEvidence(db, {
      target: { factId: old },
      sourceVersionId: versionId,
      start: 0,
      end: 4,
      quote: "근거문장",
    });
    const hiding: typeof registry = {
      ...registry,
      visible: (d, refs, purpose) =>
        registry.visible(d, refs, purpose).filter((r) => !(r.kind === "fact" && hidden.has(r.id))),
    };
    const reading = {
      db,
      registry: hiding,
      judge: createJudge(db, hiding, "search", false),
      question: "프로브",
    };
    const admit = (ids: readonly number[]) => {
      const shown = shownVersions(db, hiding, ids);
      return ids.filter((id) => shown.has(id));
    };
    expect(temporalIds(reading, [], admit)).toEqual([versionId]);
  });
});
