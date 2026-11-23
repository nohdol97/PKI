// Test support (a `*.test-support.ts` file: refused in product code by lint and the bundle). Loads the
// synthetic lint fixture (fixtures/k02-reflection.json) into a migrated DB and runs a re-review the way the
// runner does: plan, then the result in one commitDerived transaction. Not exported from the package.
import {
  addEvidence,
  commitDerived,
  insertItem,
  listFindings,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { planReflect, type ReflectOptions, type ReflectTarget } from "./reflect-job.ts";

interface Fixture {
  now: string;
  sources: { key: string; bodies: string[] }[];
  items: { key: string; type: string; name: string }[];
  facts: { item: string; kind: string; value: string; cite: [string, number][] }[];
  relations: {
    key: string;
    subject: string;
    type: string;
    object: string;
    cite: [string, number][];
  }[];
  staleCandidates: [string, string][];
  expect: Record<string, string[][]>;
}

export const lintFixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/k02-reflection.json"), "utf8"),
) as Fixture;

export const NOW = lintFixture.now;
export const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

/** The fixture's rows by key. */
export interface LoadedLint {
  items: Map<string, number>;
  relations: Map<string, number>;
  /** The row id of a stored source version: `(source key, version)`. */
  version: (key: string, version: number) => number;
  /** The source ids by key. */
  sources: Map<string, number>;
}

export function loadLintFixture(db: SqlDriver): LoadedLint {
  registerConnectorInstance(db, "c1", "test-fixtures");
  const sources = new Map<string, number>();
  const versions = new Map<string, number>();
  for (const s of lintFixture.sources) {
    for (const [i, body] of s.bodies.entries()) {
      const saved = saveSourceRecord(db, "c1", { externalId: s.key, title: `제목 ${s.key}`, body });
      if (saved.status !== "created") throw new Error(saved.status);
      sources.set(s.key, saved.sourceId);
      versions.set(
        `${s.key}@${i + 1}`,
        db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number,
      );
    }
  }
  const version = (key: string, n: number) => versions.get(`${key}@${n}`) as number;
  const cite = (target: { factId: number } | { relationId: number }, at: [string, number][]) => {
    for (const [key, n] of at) {
      const body = db.all("SELECT body FROM source_versions WHERE id = ?", [version(key, n)])[0]
        ?.body as string;
      addEvidence(db, {
        target,
        sourceVersionId: version(key, n),
        start: 0,
        end: [...body].length,
        quote: body,
      });
    }
  };
  const items = new Map<string, number>();
  for (const i of lintFixture.items) {
    items.set(i.key, insertItem(db, { type: i.type, name: i.name, ...attrs }));
  }
  for (const f of lintFixture.facts) {
    const itemId = items.get(f.item) as number;
    cite({ factId: saveFact(db, { itemId, kind: f.kind, value: f.value, ...attrs }).id }, f.cite);
  }
  const relations = new Map<string, number>();
  for (const r of lintFixture.relations) {
    const id = saveRelation(db, {
      subjectId: items.get(r.subject) as number,
      type: r.type,
      objectId: items.get(r.object) as number,
      ...attrs,
    }).id;
    relations.set(r.key, id);
    cite({ relationId: id }, r.cite);
  }
  for (const [a, b] of lintFixture.staleCandidates) {
    const [x, y] = [items.get(a) as number, items.get(b) as number].sort((p, q) => p - q) as [
      number,
      number,
    ];
    db.run("INSERT INTO merge_candidates (item_a, item_b, signals, at) VALUES (?, ?, ?, ?)", [
      x,
      y,
      JSON.stringify(["name-match"]),
      NOW,
    ]);
  }
  return { items, relations, version, sources };
}

/** One re-review as the runner does it; the counts the run left. */
export function reflectNow(
  db: SqlDriver,
  target: ReflectTarget = "daily",
  options: ReflectOptions & { at?: string } = {},
) {
  const { at = NOW, ...rest } = options;
  const plan = planReflect(db, target, at, rest);
  const committed = db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
  return { plan, committed, counts: plan.counts };
}

export const findingKeys = (db: SqlDriver) =>
  listFindings(db).map((f) => `${f.rule}:${f.status}:${f.fingerprint}`);
