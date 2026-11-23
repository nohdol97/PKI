// Test support (a `*.test-support.ts` file: refused in product code by lint and the bundle). Builders for the
// Wiki tests (K01): a source version, a cited fact or relation, an item, and the build the job would do, run
// through commitDerived in one transaction. Synthetic text only. Not exported from the package.
import {
  addEvidence,
  commitDerived,
  insertItem,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { planWikiBuild } from "./wiki-build-job.ts";

export const AT = "2026-11-23T00:00:00.000Z";
export const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

/** A new source with one version: its source id, the version row id, and the version number. */
export function addSource(
  db: SqlDriver,
  externalId: string,
  body: string,
  accessScope?: readonly string[],
) {
  const saved = saveSourceRecord(db, "c1", {
    externalId,
    title: `제목 ${externalId}`,
    body,
    ...(accessScope ? { accessScope } : {}),
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { sourceId: saved.sourceId, id, version: saved.version };
}

/** Evidence quoting the whole body of version row `versionId`. */
export function cite(
  db: SqlDriver,
  target: { factId: number } | { relationId: number },
  versionId: number,
): number {
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

export const addItem = (db: SqlDriver, type: string, name: string): number =>
  insertItem(db, { type, name, ...attrs });
export const addFact = (db: SqlDriver, itemId: number, kind: string, value: string): number =>
  saveFact(db, { itemId, kind, value, ...attrs }).id;
export const addRelation = (db: SqlDriver, subjectId: number, type: string, objectId: number) =>
  saveRelation(db, { subjectId, type, objectId, ...attrs }).id;

/** What the `wiki-build` job writes for the current state, committed in one transaction. */
export function buildWiki(
  db: SqlDriver,
  options: { force?: boolean; cap?: number; at?: string } = {},
) {
  const plan = planWikiBuild(db, { at: AT, ...options });
  const committed = db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
  return { plan, committed };
}
