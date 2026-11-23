// Test-build-only seed for the curation browser E2E (X02B-C8, C9): the V02 "plain" set (a Project and a System
// with a relation and candidate facts) plus a second item of the Project type to merge into the first, and
// FILLER candidate items so the 지식 검토 list needs "더 보기" (one page is 50 items). Run with `node` before the
// E2E starts the backend:
//   node backend/src/x02b-curation-seed.e2e.ts --data-dir DIR
import { insertItem } from "@pki/storage";
import { parseArgs } from "node:util";
import { openCanonicalDb } from "./composition.ts";
import { seedV02 } from "./v02-seed.e2e.ts";

export const MERGE_TARGET = "새별 프로젝트";
const FILLER = 55;

if (import.meta.main) {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
  const dir = values["data-dir"];
  if (!dir) throw new Error("--data-dir is required");
  const db = openCanonicalDb(dir);
  try {
    if ((await seedV02(db, ["plain"])) > 0) throw new Error("seed jobs did not finish");
    const attrs = {
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    } as const;
    insertItem(db, { type: "Project", name: MERGE_TARGET, ...attrs });
    for (let i = 0; i < FILLER; i += 1)
      insertItem(db, { type: "Concept", name: `채움 항목 ${i}`, ...attrs });
  } finally {
    db.close();
  }
}
