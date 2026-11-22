// Registration coverage (I04-R3): every place derived or source-bearing data can live is classified,
// so that something nobody registered for invalidation turns a check red instead of escaping a deletion.
// Three checks, each failing closed on what it does not know:
//   - tables: every table of the schema is the source row, a registered kind's, or operational;
//   - data directory: every entry is a registered kind's path or an operational one;
//   - bound adapters: the KnowledgeEngine and VectorIndex the composition binds are registered
//     projection kinds, and neither subclasses the null implementation (`permanentlyAbsent` is an
//     `instanceof` test, so a subclass would turn a stopped sidecar into a skipped removal).
// The tables and the data directory are checked by tests (derivative-coverage.test.ts); the adapters
// are also checked at start (boot.ts), where a failure refuses the start.
import type { KnowledgeEngine, VectorIndex } from "@pki/contracts";
import { ENGINE_KIND, VECTOR_KIND } from "@pki/knowledge-engine";
import type { DerivativeRegistry, SqlDriver } from "@pki/storage";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NULL_IMPLEMENTATIONS } from "./composition.ts";

/** How a table is classified. */
export type TableClass =
  | { readonly class: "source" }
  | { readonly class: "kind"; readonly kind: string }
  /** Operational: holds no derived data and nothing that names a source version; one line says why. */
  | { readonly class: "operational"; readonly reason: string };

const kind = (name: string): TableClass => ({ class: "kind", kind: name });
const operational = (reason: string): TableClass => ({ class: "operational", reason });

/**
 * Every table of the schema (SQLite's own `sqlite_*` tables aside). A table a migration adds is
 * classified HERE, in the same change: as the source row (only `sources`), as a registered kind's
 * (`kind(<name in the registry>)`, and the kind must delete its rows), or as operational with a reason.
 * Nothing is classified before its table exists.
 */
export const TABLE_CLASSIFICATION: Readonly<Record<string, TableClass>> = {
  sources: { class: "source" },
  source_versions: kind("source"),
  // the FTS5 table and its shadow tables
  keyword_index: kind("source"),
  keyword_index_config: kind("source"),
  keyword_index_data: kind("source"),
  keyword_index_docsize: kind("source"),
  keyword_index_idx: kind("source"),
  evidence: kind("evidence"),
  facts: kind("fact"),
  relations: kind("relation"),
  items: kind("item"),
  // the lifecycle history of a row (S01-R6, R22): numbers and codes only, deleted with its row, so it
  // belongs to the kind of the row it records
  item_history: kind("item"),
  fact_history: kind("fact"),
  relation_history: kind("relation"),
  insights: kind("insight"),
  insight_evidence: kind("insight"),
  // the user-input rows an Insight used (S01-R15): the Insight's, deleted with it or with the row
  insight_user_inputs: kind("insight"),
  // the type definitions with their lineage and history (S01-R22): the registered kind `ontology`
  // deletes the lineage rows of a deleted source and the candidates left with none
  ontology_elements: kind("ontology"),
  ontology_basis: kind("ontology"),
  ontology_history: kind("ontology"),
  // what the scope policy left out of an extraction (I04-T09): the registered kind `scope-drop` deletes them with their source
  scope_policy_drops: kind("scope-drop"),
  jobs: operational("work queue: a row names a source by id and holds no content"),
  schedules: operational("periods of the schedule (I03)"),
  consents: operational("the user's consent per Provider"),
  settings: operational("settings and the projections' stale marks"),
  provider_calls: operational("Provider call history, no content"),
  tombstones: operational("deletion records, the identity hashed (I04-R6, R7)"),
  revisions: operational("the revision numbers of the sources"),
  invalidations: operational("content-free record of each propagation (I04-R4)"),
  identity_key: operational("the key that hashes identities (I04-R7)"),
  connector_instances: operational("Connector instance settings"),
};

/** Columns that name a derived row; an operational table may not have one (nor a foreign key to its tables). */
const ID_COLUMNS = [
  "source_version_id",
  "evidence_id",
  "fact_id",
  "relation_id",
  "item_id",
  "insight_id",
];

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * What is wrong with the schema's classification; empty when every table is classified, every kind
 * named exists in the registry, and no operational table points at a kind's tables.
 */
export function checkTableCoverage(
  db: SqlDriver,
  registry: Pick<DerivativeRegistry, "kinds">,
  classification: Readonly<Record<string, TableClass>> = TABLE_CLASSIFICATION,
): string[] {
  const problems: string[] = [];
  const kindNames = new Set(registry.kinds.map((k) => k.kind));
  const tables = db
    .all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .map((r) => r.name as string);
  // SQLite identifiers are case-insensitive: the schema's names are compared lower-cased, so the
  // classification's names (the keys of the list) are written in lower case
  const byName = new Map(Object.entries(classification));
  const kindTables = new Set(
    Object.entries(classification)
      .filter(([, c]) => c.class === "kind")
      .map(([name]) => name),
  );
  for (const table of tables) {
    const entry = byName.get(table.toLowerCase());
    if (!entry) {
      problems.push(
        `table "${table}" is not classified: add it to TABLE_CLASSIFICATION (backend/src/derivative-coverage.ts) as the source row, a registered kind's table (and make that kind delete its rows), or operational with a reason`,
      );
      continue;
    }
    if (entry.class === "kind" && !kindNames.has(entry.kind)) {
      problems.push(
        `table "${table}" is classified under kind "${entry.kind}", which is not registered`,
      );
    }
    if (entry.class === "operational") {
      for (const fk of db.all(`PRAGMA foreign_key_list(${quoted(table)})`)) {
        if (kindTables.has((fk.table as string).toLowerCase())) {
          problems.push(`operational table "${table}" has a foreign key to "${String(fk.table)}"`);
        }
      }
      for (const col of db.all(`PRAGMA table_info(${quoted(table)})`)) {
        if (ID_COLUMNS.includes((col.name as string).toLowerCase())) {
          problems.push(
            `operational table "${table}" has the derived-row column "${String(col.name)}"`,
          );
        }
      }
    }
  }
  const existing = new Set(tables.map((t) => t.toLowerCase()));
  for (const name of Object.keys(classification)) {
    if (!existing.has(name)) problems.push(`classified table "${name}" does not exist: remove it`);
  }
  return problems;
}

/** The entries of the data directory that are operational (V01-T10, T11, T14); a kind's are its `dataPaths`. */
export const OPERATIONAL_DATA_ENTRIES: readonly RegExp[] = [
  /^pki\.sqlite(-journal|-wal|-shm)?$/, // the canonical DB and its side files
  /^models(\/|$)/, // the embedding model cache
  /^secrets\.json$/, // secret values
  /^secrets\.json\.[^/]*\.tmp$/, // while a secrets write is in flight
  /^cli-runs(\/|$)/, // one temporary folder per CLI run, swept at start
  // the tombstone ledger (I04-T10, R17): keyed hashes and plain connector instance ids of deleted
  // sources, no source content. The names set aside beside it are made only when a ledger's key differs
  // from the database's or its header is damaged.
  /^tombstone-ledger\.jsonl(\.tmp)?$/, // the ledger; `.tmp` is a new one a crash left before its rename
  /^tombstone-ledger\.(other-key|damaged)-[1-9][0-9]*\.jsonl$/,
];

/**
 * The entries under `dir` (paths relative, `/` separated) that no registered kind's `dataPaths` and
 * no operational entry covers. A directory some kind's path lies below is descended into.
 */
export function checkDataDirectory(
  dir: string,
  registry: Pick<DerivativeRegistry, "kinds">,
  operationalEntries: readonly RegExp[] = OPERATIONAL_DATA_ENTRIES,
): string[] {
  const paths = registry.kinds.flatMap((k) => k.dataPaths.map((p) => p.replaceAll("\\", "/")));
  const unclaimed: string[] = [];
  const walk = (rel: string): void => {
    if (operationalEntries.some((re) => re.test(rel))) return;
    if (paths.some((p) => p === rel || rel.startsWith(`${p}/`))) return;
    if (paths.some((p) => p.startsWith(`${rel}/`))) {
      for (const entry of readdirSync(join(dir, rel))) walk(`${rel}/${entry}`);
      return;
    }
    unclaimed.push(rel);
  };
  for (const entry of readdirSync(dir)) walk(entry);
  return unclaimed.map(
    (rel) =>
      `data directory entry "${rel}" is neither a registered kind's path nor operational: declare it in the kind's dataPaths, or add it to OPERATIONAL_DATA_ENTRIES (backend/src/derivative-coverage.ts)`,
  );
}

/**
 * What is wrong with the adapters the composition binds: a missing registered projection kind, or an
 * implementation that subclasses the null one (a subclass is neither "never holds anything" nor an
 * exact match for the `permanentlyAbsent` mark).
 */
export function checkBoundAdapters(
  registry: Pick<DerivativeRegistry, "kinds">,
  adapters: { engine: KnowledgeEngine; vectorIndex: VectorIndex },
): string[] {
  return boundAdapterProblems(registry, adapters).map((p) => p.message);
}

function boundAdapterProblems(
  registry: Pick<DerivativeRegistry, "kinds">,
  adapters: { engine: KnowledgeEngine; vectorIndex: VectorIndex },
): { name: string; message: string }[] {
  const problems: { name: string; message: string }[] = [];
  const projections = new Set(
    registry.kinds.filter((k) => k.storage === "projection").map((k) => k.kind),
  );
  for (const [name, bound] of [
    [ENGINE_KIND, adapters.engine],
    [VECTOR_KIND, adapters.vectorIndex],
  ] as const) {
    if (!projections.has(name)) {
      problems.push({
        name,
        message: `the bound ${name} implementation has no registered projection kind "${name}"`,
      });
    }
    const base = NULL_IMPLEMENTATIONS[name];
    if (bound instanceof base && Object.getPrototypeOf(bound) !== base.prototype) {
      problems.push({
        name,
        message: `the bound ${name} implementation subclasses ${base.name}: a real adapter must implement the port itself`,
      });
    }
  }
  return problems;
}

/**
 * The refusal of the start. The shell logs only an error's `name` (shell.ts), so the name carries the
 * fixed adapter kind names ("engine", "vectorIndex"); the message is fixed text and holds no path or data.
 */
export class UnregisteredAdapterError extends Error {
  constructor(adapterKinds: readonly string[], message: string) {
    super(message);
    this.name = `UnregisteredAdapterError(${adapterKinds.join(",")})`;
  }
}

/** Refuses the start (throws) when `checkBoundAdapters` finds anything. */
export function assertBoundAdaptersRegistered(
  registry: Pick<DerivativeRegistry, "kinds">,
  adapters: { engine: KnowledgeEngine; vectorIndex: VectorIndex },
): void {
  const problems = boundAdapterProblems(registry, adapters);
  if (problems.length > 0) {
    throw new UnregisteredAdapterError(
      [...new Set(problems.map((p) => p.name))],
      `refusing to start: ${problems.map((p) => p.message).join("; ")}`,
    );
  }
}
