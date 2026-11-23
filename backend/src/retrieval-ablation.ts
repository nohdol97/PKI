// X01-R17 retrieval ablation runner. The Golden Dataset's sources go in through the product's import path (the
// JSONL importer of the composition root); the knowledge (items, relations, dated facts, aliases, replacements) is
// planted from the dev labels with no Provider, so the figures of the graph, concept, temporal and wiki
// configurations are the upper bound when extraction is perfect. Each of the five configurations runs the dev
// questions through `retrieve` and gives the predictions lines `eval/scorer/score.py` reads. Only the dev split is
// ever run: the sealed eval split is refused (EVALUATION 3.1). Nothing here is a product path; the vector index and
// the embedder are handed in, because the vector index lives in memory only and the embedder is an adapter.
import type { EmbeddingProvider, VectorIndex } from "@pki/contracts";
import {
  createProductRegistry,
  locateQuote,
  renderWikiPages,
  retrieve,
  type StrategyName,
} from "@pki/knowledge-engine";
import {
  addEvidence,
  defaultScopePolicy,
  insertAssertionLink,
  insertItem,
  type KnowledgeStatus,
  saveFact,
  saveRelation,
  writeWikiPage,
  type SqlDriver,
} from "@pki/storage";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openCanonicalDb, productImporter } from "./composition.ts";

/** The five configurations of EVALUATION 3, each adding strategies to the one before. */
export const CONFIGS = [
  { id: "C1", name: "Keyword", add: [] },
  { id: "C2", name: "Keyword + Vector", add: ["vector"] },
  { id: "C3", name: "+ Graph", add: ["graph"] },
  { id: "C4", name: "+ Semantic", add: ["concept", "temporal"] },
  { id: "C5", name: "+ Wiki", add: ["wiki"] },
] as const satisfies readonly { id: string; name: string; add: readonly StrategyName[] }[];

export interface AblationVector {
  embedding: EmbeddingProvider;
  index: VectorIndex;
}

export interface AblationInput {
  goldenDir: string;
  /** The development split is the only one that runs (EVALUATION 3.1); anything else is refused. */
  split?: "dev";
  /** A sample of dev question ids; all dev questions when absent. */
  questionIds?: readonly string[];
  vector?: AblationVector | undefined;
  /** Why the vector configuration was not measured, when no `vector` is given. */
  vectorNotMeasured?: string | undefined;
}

export interface QuestionScore {
  recall: number;
  rr: number;
}

export type ConfigRun =
  | {
      id: string;
      name: string;
      status: "measured";
      strategies: StrategyName[];
      /** The id of the configuration this one is compared with in the keep rule (the last measured before it). */
      base: string | null;
      lines: string[];
      latencyMs: number[];
      /** For each strategy, the number of questions on which its route entry was `used` (a strategy never asked is 0). */
      routeUsed: Record<string, number>;
      /** Recall@5 and the reciprocal rank by question, for the answerable ones (the keep rule's counts). */
      perQuestion: Record<string, QuestionScore>;
    }
  | { id: string; name: string; status: "not-measured"; reason: string };

export interface SeedCounts {
  items: number;
  relations: number;
  facts: number;
  aliases: number;
  replacements: number;
  evidence: number;
  skipped: Record<string, number>;
}

export interface AblationRun {
  split: "dev";
  corpus: { tier: "T0"; lines: number; received: number; errors: number };
  questions: { asked: number; answerable: number };
  seeded: SeedCounts;
  configs: ConfigRun[];
}

type Row = Record<string, unknown>;
interface Evidence {
  record_id: string;
  version: number;
  quote: string;
}

const readJsonl = (path: string): Row[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);

const TOP_K = 5;
const OBSERVED_AT = "2026-11-21T00:00:00Z";
const LINKED_AT = "2026-11-23T00:00:00.000Z";
/** The statuses a label gives that a stored fact can have; `removed` and `restricted` are not knowledge to plant. */
const PLANTED_STATUS = new Set(["verified", "disputed", "superseded"]);

export async function runAblation(input: AblationInput): Promise<AblationRun> {
  if (input.split !== undefined && input.split !== "dev") {
    throw new Error("the eval split is sealed (EVALUATION 3.1); the ablation runs dev only");
  }
  const labels = (name: string) => readJsonl(resolve(input.goldenDir, "labels", name));
  const sourcesDir = resolve(input.goldenDir, "sources");
  const sourceFiles = readdirSync(sourcesDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const lines = sourceFiles.flatMap((f) => readJsonl(resolve(sourcesDir, f)));
  const dev = new Set(
    (
      JSON.parse(readFileSync(resolve(input.goldenDir, "splits.json"), "utf8")) as {
        splits: { dev: string[] };
      }
    ).splits.dev,
  );
  const inDev = (row: Row) => dev.has(row.scenario_instance as string);

  const dir = mkdtempSync(join(tmpdir(), "pki-ablation-"));
  const db = openCanonicalDb(join(dir, "data"));
  try {
    // T0: the whole golden corpus, through the import path, file by file as the product's own tests do
    const importer = productImporter(db, { logger: () => undefined });
    let received = 0;
    let errors = 0;
    for (const file of sourceFiles) {
      const result = await importer(readFileSync(resolve(sourcesDir, file), "utf8"));
      received += result.received;
      errors += result.errorCount;
    }

    const registry = createProductRegistry({ policy: defaultScopePolicy });
    const world = locate(db, lines);
    const seeded = seed(db, labels, inDev, world);
    for (const page of renderWikiPages(db)) writeWikiPage(db, page, LINKED_AT);

    const questions = labels("qa.jsonl")
      .filter(inDev)
      .filter(
        (q) => input.questionIds === undefined || input.questionIds.includes(q.label_id as string),
      );

    const vector = await prepareVector(db, input);
    const configs: ConfigRun[] = [];
    const strategies: StrategyName[] = ["keyword"];
    let base: string | null = null;
    for (const config of CONFIGS) {
      if (config.id === "C2") {
        if (typeof vector === "string") {
          configs.push({
            id: config.id,
            name: config.name,
            status: "not-measured",
            reason: vector,
          });
          continue;
        }
      }
      strategies.push(...config.add);
      const enabled = [...strategies];
      const lines: string[] = [];
      const latencyMs: number[] = [];
      const perQuestion: Record<string, QuestionScore> = {};
      const routeUsed: Record<string, number> = {};
      for (const q of questions) {
        const started = performance.now();
        const found = await retrieve(
          db,
          registry,
          q.question as string,
          {},
          { enabled, ...(typeof vector === "string" ? {} : { vector }) },
        );
        latencyMs.push(performance.now() - started);
        for (const [name, entry] of Object.entries(found.route)) {
          if (entry.status === "used") routeUsed[name] = (routeUsed[name] ?? 0) + 1;
        }
        // the caller's own read gate (R12): only what the policy shows for a search is let out
        const shown = new Set(
          registry
            .visible(
              db,
              found.hits.map((h) => ({ kind: "source", id: String(h.versionId) })),
              "search",
            )
            .map((r) => Number(r.id)),
        );
        const ranked = [
          ...new Set(
            found.hits.filter((h) => shown.has(h.versionId)).map((h) => world.recordOf(h.sourceId)),
          ),
        ];
        const id = q.label_id as string;
        lines.push(JSON.stringify({ kind: "retrieval", query_id: id, ranked }));
        if (q.answerable === true)
          perQuestion[id] = scoreQuestion(ranked, q.evidence as Evidence[]);
      }
      configs.push({
        id: config.id,
        name: config.name,
        status: "measured",
        strategies: enabled,
        base,
        lines,
        latencyMs,
        routeUsed,
        perQuestion,
      });
      base = config.id;
    }
    return {
      split: "dev",
      corpus: { tier: "T0", lines: lines.length, received, errors },
      questions: {
        asked: questions.length,
        answerable: questions.filter((q) => q.answerable === true).length,
      },
      seeded,
      configs,
    };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Recall@5 and the reciprocal rank of one ranked list against a question's evidence records (as score.py computes them). */
function scoreQuestion(ranked: readonly string[], evidence: readonly Evidence[]): QuestionScore {
  const relevant = new Set(evidence.map((e) => e.record_id));
  const top = new Set(ranked.slice(0, TOP_K));
  const first = ranked.findIndex((r) => relevant.has(r));
  return {
    recall: [...relevant].filter((r) => top.has(r)).length / relevant.size,
    rr: first === -1 ? 0 : 1 / (first + 1),
  };
}

/** The golden record behind each stored source and version, found by the instance and external id the import stored. */
function locate(db: SqlDriver, lines: readonly Row[]) {
  const recordBySource = new Map<number, string>();
  const versionRow = new Map<string, number>();
  for (const l of lines) {
    const instance = l.connector_instance_id as string;
    const source = db.all(
      "SELECT id FROM sources WHERE connector_instance_id = ? AND external_id = ?",
      [instance, l.external_id as string],
    )[0]?.id as number | undefined;
    if (source === undefined) continue;
    recordBySource.set(source, l.id as string);
    if (l.operation !== "upsert") continue;
    const row = db.all("SELECT id FROM source_versions WHERE source_id = ? AND body = ?", [
      source,
      l.content as string,
    ])[0]?.id as number | undefined;
    if (row !== undefined) versionRow.set(`${l.id as string}#${String(l.version)}`, row);
  }
  return {
    recordOf: (sourceId: number) => recordBySource.get(sourceId) ?? `unknown-source-${sourceId}`,
    versionOf: (e: Evidence) => versionRow.get(`${e.record_id}#${String(e.version)}`),
  };
}

/** Plants the dev labels' knowledge with no Provider: the upper bound when extraction is perfect (X01-D12). */
function seed(
  db: SqlDriver,
  labels: (name: string) => Row[],
  inDev: (row: Row) => boolean,
  world: ReturnType<typeof locate>,
): SeedCounts {
  const counts: SeedCounts = {
    items: 0,
    relations: 0,
    facts: 0,
    aliases: 0,
    replacements: 0,
    evidence: 0,
    skipped: {},
  };
  const skip = (reason: string) => (counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1);
  const attrs = (status: KnowledgeStatus, validAt: unknown) =>
    ({
      epistemic: "explicit",
      status,
      validAt: (validAt as string | null) ?? null,
      observedAt: OBSERVED_AT,
    }) as const;

  /** Adds each label evidence the stored text still holds; returns how many were added. */
  const cite = (target: { factId: number } | { relationId: number }, evidence: Evidence[]) => {
    let added = 0;
    for (const e of evidence) {
      const versionId = world.versionOf(e);
      const body =
        versionId === undefined
          ? undefined
          : (db.all("SELECT body FROM source_versions WHERE id = ?", [versionId])[0]
              ?.body as string);
      const span = body === undefined ? undefined : locateQuote(body, e.quote);
      if (versionId === undefined || span === undefined || "dropped" in span) {
        skip("evidence-not-in-stored-text");
        continue;
      }
      addEvidence(db, { target, sourceVersionId: versionId, quote: e.quote, ...span });
      counts.evidence++;
      added++;
    }
    return added;
  };

  const item = new Map<string, number>();
  const entities = labels("entities.jsonl").filter(inDev);
  for (const e of entities) {
    if (e.expected_absent === true) {
      skip("entity-expected-absent");
      continue;
    }
    item.set(
      e.entity_id as string,
      insertItem(db, {
        type: e.entity_type as string,
        name: e.name as string,
        ...attrs("verified", null),
      }),
    );
    counts.items++;
  }
  for (const e of entities) {
    const itemId = item.get(e.entity_id as string);
    if (itemId === undefined) continue;
    for (const alias of e.aliases as string[]) {
      const fact = saveFact(db, {
        itemId,
        kind: "alias.surface",
        value: alias,
        ...attrs("verified", null),
      });
      const added = cite(
        { factId: fact.id },
        (e.evidence as Evidence[]).map((x) => ({ ...x, quote: alias })),
      );
      if (added === 0) skip("alias-without-evidence");
      else counts.aliases++;
    }
  }
  for (const r of labels("relations.jsonl").filter(inDev)) {
    const subject = item.get(r.subject as string);
    const object = item.get(r.object as string);
    if (r.expected !== true || subject === undefined || object === undefined) {
      skip(r.expected === true ? "relation-endpoint-missing" : "relation-must-not-link");
      continue;
    }
    const saved = saveRelation(db, {
      subjectId: subject,
      type: r.relation as string,
      objectId: object,
      validUntil: (r.valid_until as string | null) ?? null,
      ...attrs("verified", r.valid_from),
    });
    if (cite({ relationId: saved.id }, r.evidence as Evidence[]) === 0)
      skip("relation-without-evidence");
    else counts.relations++;
  }
  const factOf = new Map<string, number>();
  const facts = labels("temporal_facts.jsonl").filter(inDev);
  for (const f of facts) {
    const itemId = item.get(f.subject as string);
    if (!PLANTED_STATUS.has(f.expected_status as string) || itemId === undefined) {
      skip(`fact-${String(f.expected_status)}`);
      continue;
    }
    const saved = saveFact(db, {
      itemId,
      kind: f.attribute as string,
      value: String(f.value),
      validUntil: (f.valid_until as string | null) ?? null,
      ...attrs(f.expected_status as KnowledgeStatus, f.valid_from),
    });
    if (cite({ factId: saved.id }, f.evidence as Evidence[]) === 0) {
      skip("fact-without-evidence");
      continue;
    }
    factOf.set(f.label_id as string, saved.id);
    counts.facts++;
  }
  for (const f of facts) {
    const from = factOf.get(f.label_id as string);
    const to = f.supersedes === null ? undefined : factOf.get(f.supersedes as string);
    if (from === undefined || to === undefined) continue;
    insertAssertionLink(db, {
      type: "SUPERSEDES",
      fromFactId: from,
      toFactId: to,
      createdBy: "rule",
      at: LINKED_AT,
    });
    counts.replacements++;
  }
  return counts;
}

/**
 * Embeds every stored source version into the in-memory index. Returns the deps to hand to `retrieve`, or the
 * reason the vector configuration is not measured (nothing is faked: a model that is not ready is a reason).
 */
async function prepareVector(
  db: SqlDriver,
  input: AblationInput,
): Promise<AblationVector | string> {
  const { vector } = input;
  if (!vector) return input.vectorNotMeasured ?? "no embedding model was given to the runner";
  const status = await vector.embedding.status();
  if (status !== "ready") {
    return `embedding model: ${typeof status === "string" ? status : status.unavailable}`;
  }
  const { modelId, revision, dimension } = vector.embedding.describe();
  const build = await vector.index.beginRebuild({ modelId, revision, dimension });
  const versions = db
    .all("SELECT source_id AS s, version AS n, title, body FROM source_versions ORDER BY id")
    .filter((v) => (v.body as string) !== "");
  const refs = versions.map((v) => ({
    ref: `source-version:${String(v.s)}:${String(v.n)}`,
    text: `${v.title as string}\n${v.body as string}`,
  }));
  const vectors = await vector.embedding.embed(
    refs.map((r) => r.text),
    "document",
  );
  await build.upsert(
    refs.map((r, i) => ({ ref: r.ref, vector: vectors[i] as Float32Array })),
    1,
  );
  await build.activate(
    refs.map((r) => r.ref),
    1,
  );
  return vector;
}
