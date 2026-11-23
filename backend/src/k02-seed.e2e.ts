// Test-build-only seed (K02-T2): the V02 "plain" fixture set plus one Task whose target date has passed, cited
// from the mail fixture, then one re-review, so the 점검 screen has a finding with evidence to open. Run with `node`
// before an E2E starts the backend on that directory:
//   node backend/src/k02-seed.e2e.ts --data-dir DIR
import { planReflect } from "@pki/knowledge-engine";
import { addEvidence, commitDerived, insertItem, saveFact } from "@pki/storage";
import { parseArgs } from "node:util";
import { openCanonicalDb } from "./composition.ts";
import { seedV02 } from "./v02-seed.e2e.ts";

export const OVERDUE_TASK = "예약 점검 업무";
/** The sentence of the mail fixture the Task's date is cited from. */
export const OVERDUE_QUOTE = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";

if (import.meta.main) {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
  const dir = values["data-dir"];
  if (!dir) throw new Error("--data-dir is required");
  const db = openCanonicalDb(dir);
  try {
    if ((await seedV02(db, ["plain"])) > 0) throw new Error("seed jobs did not finish");
    const mail = db.all(
      "SELECT id, body FROM source_versions WHERE body LIKE ? ORDER BY id LIMIT 1",
      [`%${OVERDUE_QUOTE}%`],
    )[0];
    if (!mail) throw new Error("the mail fixture is not stored");
    const body = mail.body as string;
    const start = [...body.slice(0, body.indexOf(OVERDUE_QUOTE))].length;
    const itemId = insertItem(db, {
      type: "Task",
      name: OVERDUE_TASK,
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    });
    const factId = saveFact(db, {
      itemId,
      kind: "target_date",
      value: "2026-01-15",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    }).id;
    addEvidence(db, {
      target: { factId },
      sourceVersionId: mail.id as number,
      start,
      end: start + [...OVERDUE_QUOTE].length,
      quote: OVERDUE_QUOTE,
    });
    const plan = planReflect(db, "daily", new Date().toISOString(), {});
    db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
  } finally {
    db.close();
  }
}
