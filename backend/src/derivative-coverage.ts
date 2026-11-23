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
  // the links an Insight rested on (S02-R19): the Insight's, deleted with it or with the link
  insight_link_inputs: kind("insight"),
  // the user's feedback (P03-R11, D5): numbers and codes only, every row names an item or a row that hangs on
  // one; the foreign keys delete it with its target, so the kind `item` has nothing more to do for it
  feedback: kind("item"),
  // links between two facts (S02-R18): numbers and codes only; the registered kind `assertion-link`
  // recomputes the rule's and drops those whose fact is gone (the foreign keys cascade)
  assertion_links: kind("assertion-link"),
  // the type definitions with their lineage and history (S01-R22): the registered kind `ontology`
  // deletes the lineage rows of a deleted source and the candidates left with none
  ontology_elements: kind("ontology"),
  ontology_basis: kind("ontology"),
  ontology_history: kind("ontology"),
  // merge lines, distinct marks and split records (S02-R14, R16, R26): numbers only, the registered kind
  // `entity-merge` joins the chain around a deleted item, removes the rows an item's deletion takes and
  // rests or wakes a group when a lineage or a scope changes; the candidates are `merge-candidate`'s
  item_merges: kind("entity-merge"),
  item_distinct: kind("entity-merge"),
  item_split_moves: kind("entity-merge"),
  merge_candidates: kind("merge-candidate"),
  // what the scope policy left out of an extraction (I04-T09): the registered kind `scope-drop` deletes them with their source
  scope_policy_drops: kind("scope-drop"),
  // the analytical semantic's two tables (S03-R1, R17): the Dataset's tie to a stored table and the numbers
  // of a data check. The registered kind `analytical-check` deletes the first with its source
  dataset_tables: kind("analytical-check"),
  analytical_checks: kind("analytical-check"),
  // the Wiki projection (K01-T1): pages, their lineage, links and the user's edits are the registered kind
  // `wiki-page`'s (a deletion rewrites or deletes them in its own transaction; a hide goes with its fact by
  // the foreign key); the change log and the one-row state hold no content and name no row of a kind
  wiki_pages: kind("wiki-page"),
  wiki_page_lineage: kind("wiki-page"),
  wiki_links: kind("wiki-page"),
  wiki_edits: kind("wiki-page"),
  wiki_log: operational("page keys, counts and times of the Wiki's changes, no content (K01-R6)"),
  wiki_state: operational("one row: the Wiki's input and built sequence numbers (K01-R5)"),
  // reflection and knowledge lint (K02-T1): findings name rows by id and rule only, and their lineage is the
  // registered kind `lint-finding`'s (a deletion judges them again in its own transaction, K02-R13)
  lint_findings: kind("lint-finding"),
  lint_finding_lineage: kind("lint-finding"),
  // item ids and the sequence of their last change; a mark of an item a deletion took goes in the same transaction
  reflection_dirty: kind("lint-finding"),
  reflection_state: operational(
    "one row: the dirty sequence, the last run times, the weekly cursor (K02-R4)",
  ),
  jobs: operational("work queue: a row names a source by id and holds no content"),
  schedules: operational("periods of the schedule (I03)"),
  consents: operational("the user's consent per Provider"),
  settings: operational("settings and the projections' stale marks"),
  provider_calls: operational("Provider call history, no content"),
  // the local file index (I02B-R33): what a file is and where it was seen, so source identity like
  // `sources`, not a derivative kind (it is written before its source exists and keeps rows after a
  // deletion). A trigger on `tombstones` scrubs it; `checkTableCoverage` requires that trigger.
  local_file_entries: { class: "source" },
  local_locations: operational(
    "the places the user approved: settings, no source content (I02B-R33)",
  ),
  local_index_seq: operational(
    "one row, the counter of the local index's sequence numbers (I02B-R33)",
  ),
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
  // A source-class table other than `sources` holds source identity that a deletion must reach; the
  // only way that reaches every writer of a tombstone is a trigger on `tombstones`, for a new row and
  // for a changed one, that names it (I02B-R33). Classified without them, nothing empties it.
  const tombstoneTriggers = db
    .all("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) = 'tombstones'")
    .map((r) => String(r.sql).toLowerCase());
  for (const table of tables) {
    if (table.toLowerCase() === "sources") continue;
    if (byName.get(table.toLowerCase())?.class !== "source") continue;
    const name = table.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = new RegExp(`(?<!\\w)${name}(?!\\w)`);
    for (const event of ["insert", "update"]) {
      const onEvent = new RegExp(`\\b(after|before)\\s+${event}\\b`);
      if (!tombstoneTriggers.some((sql) => named.test(sql) && onEvent.test(sql))) {
        problems.push(
          `source-class table "${table}" has no trigger on "tombstones" that empties it when a row is ${event === "insert" ? "inserted" : "updated"}: a deletion would leave its rows (I02B-R33)`,
        );
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
  // a restore (H01): the previous database while it is applied, the staged restore and its marker, and the
  // plain snapshot of a backup in the making. Each is removed by the start that finds it.
  /^pki\.sqlite\.before-restore$/,
  /^restore(\/|$)/,
  /^backup-tmp(\/|$)/,
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
