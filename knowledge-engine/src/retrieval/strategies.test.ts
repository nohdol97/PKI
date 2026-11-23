// X01-C6a ② `keywordIds` reads in pages: the pages are admitted (visibility, conditions) before the cut, and the
// read stops at the page limit.
import {
  defaultScopePolicy,
  migrate,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { describe, expect, it } from "vitest";
import { createProductRegistry } from "../canonical-kinds.ts";
import { createJudge } from "../graph-read.ts";
import { shownVersions } from "./notes.ts";
import { keywordIds } from "./strategies.ts";

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
