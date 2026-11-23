// The Wiki projection's tables (K01): pages built from the knowledge tables, their lineage and links, the
// content-free change log, the user's edits and the state that says whether the pages are behind (stale).
// A page is a projection: it is written only by the `wiki-build` result (commitDerived) and deleted by the
// registered kind `wiki-page` in a deletion's own transaction; its scope is never stored, the lineage says it.
// The user's edits live in `wiki_edits`, beside the pages, and are laid over a page when it is read.
import type { SourceVersionRef } from "./derivatives.ts";
import { registerJob, type StoredJob } from "./jobs.ts";
import { WIKI_BUILD_KIND, WIKI_SUMMARY_KIND } from "./job-kinds.ts";
import { readChangeSeq, readKnowledgeRevision } from "./revisions.ts";
import { readSetting, writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";

export { WIKI_BUILD_KIND, WIKI_SUMMARY_KIND } from "./job-kinds.ts";

/** Provisional (K01-D5): pages one build writes; past it the sequence is not caught up and the next run goes on. */
export const WIKI_PAGE_CAP = 500;
/** Provisional (K01-R6): change-log lines kept, the oldest dropped first. */
export const WIKI_LOG_MAX = 1000;
/** Provisional (K01-D8): the source versions of a page's lineage a summary call may carry; a page with more is not summarized. */
export const WIKI_SUMMARY_MAX_VERSIONS = 8;
/** Provisional (K01-D11): summary jobs one request queues. */
export const WIKI_SUMMARY_BATCH = 50;
/** The user's switch for the LLM summary (K01-R12); anything but `on` is OFF. */
export const WIKI_SUMMARY_SETTING = "wiki.summary";
/** The longest note a user may attach (characters). */
export const WIKI_NOTE_MAX = 2000;

export interface WikiLinkInput {
  toKey: string;
  basisKind: "relation" | "insight";
  basisId: number;
}

export interface WikiPageInput {
  key: string;
  kind: string;
  /** The subject: the representative item's id, or the Insight's. */
  target: string;
  title: string;
  /** The page document, JSON with a fixed key order (the hash is of it). */
  body: string;
  contentHash: string;
  lineage: readonly SourceVersionRef[];
  links: readonly WikiLinkInput[];
}

export interface StoredWikiPage {
  key: string;
  kind: string;
  target: string;
  title: string;
  body: string;
  contentHash: string;
  summary: string | null;
  summaryHash: string | null;
  createdAt: string;
  updatedAt: string;
}

const pageOf = (r: Record<string, unknown>): StoredWikiPage => ({
  key: r.key as string,
  kind: r.kind as string,
  target: r.target as string,
  title: r.title as string,
  body: r.body as string,
  contentHash: r.content_hash as string,
  summary: r.summary as string | null,
  summaryHash: r.summary_hash as string | null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export const listStoredWikiPages = (db: SqlDriver): StoredWikiPage[] =>
  db.all("SELECT * FROM wiki_pages ORDER BY key").map(pageOf);

export function readStoredWikiPage(db: SqlDriver, key: string): StoredWikiPage | undefined {
  const row = db.all("SELECT * FROM wiki_pages WHERE key = ?", [key])[0];
  return row ? pageOf(row) : undefined;
}

/** The stored pages' keys and titles by kind, kinds and keys ascending (the index before the gate's filter). */
export function listWikiIndex(
  db: SqlDriver,
): { kind: string; pages: { key: string; title: string }[] }[] {
  const kinds = new Map<string, { key: string; title: string }[]>();
  for (const r of db.all("SELECT key, kind, title FROM wiki_pages ORDER BY kind, key")) {
    const list = kinds.get(r.kind as string) ?? [];
    list.push({ key: r.key as string, title: r.title as string });
    kinds.set(r.kind as string, list);
  }
  return [...kinds].map(([kind, pages]) => ({ kind, pages }));
}

export const lineageOfWikiPage = (db: SqlDriver, key: string): SourceVersionRef[] =>
  db
    .all(
      "SELECT source_id, version FROM wiki_page_lineage WHERE page_key = ? ORDER BY source_id, version",
      [key],
    )
    .map((r) => ({ sourceId: r.source_id as number, version: r.version as number }));

/** The ids a body's claims name, `fact:3` / `relation:7`; a body that is not the page shape names none. */
function claimKeys(body: string): Set<string> {
  try {
    const claims = (JSON.parse(body) as { claims?: { ref?: { kind: string; id: number } }[] })
      .claims;
    return new Set((claims ?? []).flatMap((c) => (c.ref ? [`${c.ref.kind}:${c.ref.id}`] : [])));
  } catch {
    return new Set();
  }
}

function appendLog(
  tx: SqlDriver,
  line: { key: string; action: "created" | "changed" | "removed"; added: number; removed: number },
  at: string,
): void {
  tx.run(
    `INSERT INTO wiki_log (page_key, action, knowledge_revision, change_seq, added, removed, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      line.key,
      line.action,
      readKnowledgeRevision(tx),
      readChangeSeq(tx),
      line.added,
      line.removed,
      at,
    ],
  );
  tx.run("DELETE FROM wiki_log WHERE id <= (SELECT max(id) FROM wiki_log) - ?", [WIKI_LOG_MAX]);
}

/**
 * Writes one page with its lineage and links, in the caller's transaction (the job's result). A page whose
 * hash is unchanged is left as it is (its time, log and summary too). A page whose content changed has its
 * summary cleared: the hash covers the lineage, so no sentence drawn from a deleted source stays at rest (K01-R13).
 */
export function writeWikiPage(
  tx: SqlDriver,
  page: WikiPageInput,
  at: string,
): "created" | "changed" | "unchanged" {
  const stored = tx.all("SELECT body, content_hash FROM wiki_pages WHERE key = ?", [page.key])[0];
  if (stored?.content_hash === page.contentHash) return "unchanged";
  if (stored) {
    tx.run(
      `UPDATE wiki_pages SET kind = ?, target = ?, title = ?, body = ?, content_hash = ?, updated_at = ?,
         summary = NULL, summary_hash = NULL WHERE key = ?`,
      [page.kind, page.target, page.title, page.body, page.contentHash, at, page.key],
    );
    tx.run("DELETE FROM wiki_page_lineage WHERE page_key = ?", [page.key]);
    tx.run("DELETE FROM wiki_links WHERE from_key = ?", [page.key]);
  } else {
    tx.run(
      `INSERT INTO wiki_pages (key, kind, target, title, body, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [page.key, page.kind, page.target, page.title, page.body, page.contentHash, at, at],
    );
  }
  for (const v of page.lineage) {
    tx.run(
      "INSERT OR IGNORE INTO wiki_page_lineage (page_key, source_id, version) VALUES (?, ?, ?)",
      [page.key, v.sourceId, v.version],
    );
  }
  for (const l of page.links) {
    tx.run(
      "INSERT OR IGNORE INTO wiki_links (from_key, to_key, basis_kind, basis_id) VALUES (?, ?, ?, ?)",
      [page.key, l.toKey, l.basisKind, l.basisId],
    );
  }
  const before = claimKeys(stored ? (stored.body as string) : "");
  const after = claimKeys(page.body);
  appendLog(
    tx,
    {
      key: page.key,
      action: stored ? "changed" : "created",
      added: [...after].filter((k) => !before.has(k)).length,
      removed: [...before].filter((k) => !after.has(k)).length,
    },
    at,
  );
  return stored ? "changed" : "created";
}

/**
 * Stores a page's summary (`[{sentence, sourceId, version, start, end}]` as JSON) with the content hash it was
 * made for, in the caller's transaction. A page that changed while the call ran (another hash) is not written.
 */
export function writeWikiSummary(
  tx: SqlDriver,
  key: string,
  contentHash: string,
  summaryJson: string,
): boolean {
  return (
    tx.run(
      "UPDATE wiki_pages SET summary = ?, summary_hash = ? WHERE key = ? AND content_hash = ?",
      [summaryJson, contentHash, key, contentHash],
    ).changes === 1
  );
}

/** Deletes a page with its lineage and outgoing links, in the caller's transaction, and logs it. */
export function removeWikiPage(tx: SqlDriver, key: string, at: string): boolean {
  const stored = tx.all("SELECT body, kind, target FROM wiki_pages WHERE key = ?", [key])[0];
  if (!stored) return false;
  const removed = claimKeys(stored.body as string).size;
  tx.run("DELETE FROM wiki_pages WHERE key = ?", [key]);
  const table = stored.kind === "syntheses" ? "insights" : "items";
  if (tx.all(`SELECT 1 FROM ${table} WHERE id = ?`, [Number(stored.target)]).length === 0) {
    endWikiIncarnation(tx, key);
  } else {
    appendLog(tx, { key, action: "removed", added: 0, removed }, at);
  }
  return true;
}

/**
 * The target of a page key is gone for good, and its row id may be handed to an unrelated new row (plain
 * rowid, no AUTOINCREMENT): the key's change lines go, and the user's notes on it stay as notes on no page
 * under a key nothing is built for (K01-D20, K01-D7).
 */
export function endWikiIncarnation(tx: SqlDriver, key: string): void {
  tx.run("DELETE FROM wiki_log WHERE page_key = ?", [key]);
  tx.run(
    "UPDATE wiki_edits SET page_key = page_key || '#gone' WHERE op = 'note' AND page_key = ?",
    [key],
  );
}

/** An item row was deleted: ends the incarnation of every non-Insight page key naming it, stored or not. */
export function endWikiItemIncarnation(tx: SqlDriver, itemId: number): void {
  const keys = new Set<string>();
  for (const sql of [
    "SELECT page_key AS k FROM wiki_log WHERE page_key LIKE ?",
    "SELECT page_key AS k FROM wiki_edits WHERE op = 'note' AND page_key LIKE ?",
  ]) {
    for (const r of tx.all(sql, [`%/${itemId}`])) keys.add(r.k as string);
  }
  for (const r of tx.all("SELECT key FROM wiki_pages WHERE target = ? AND kind <> 'syntheses'", [
    String(itemId),
  ])) {
    keys.add(r.key as string);
  }
  for (const key of keys) if (!key.startsWith("syntheses/")) endWikiIncarnation(tx, key);
}

export interface WikiLogLine {
  id: number;
  pageKey: string;
  action: "created" | "changed" | "removed";
  knowledgeRevision: number;
  changeSeq: number;
  added: number;
  removed: number;
  at: string;
}

/** The newest lines first, at most `limit`; one page's when `pageKey` is given. */
export function listWikiLog(
  db: SqlDriver,
  options: { limit: number; pageKey?: string },
): WikiLogLine[] {
  return db
    .all(
      `SELECT * FROM wiki_log ${options.pageKey === undefined ? "" : "WHERE page_key = ?"}
       ORDER BY id DESC LIMIT ?`,
      options.pageKey === undefined ? [options.limit] : [options.pageKey, options.limit],
    )
    .map((r) => ({
      id: r.id as number,
      pageKey: r.page_key as string,
      action: r.action as WikiLogLine["action"],
      knowledgeRevision: r.knowledge_revision as number,
      changeSeq: r.change_seq as number,
      added: r.added as number,
      removed: r.removed as number,
      at: r.at as string,
    }));
}

export interface WikiLink {
  fromKey: string;
  toKey: string;
  basisKind: "relation" | "insight";
  basisId: number;
}

const linkOf = (r: Record<string, unknown>): WikiLink => ({
  fromKey: r.from_key as string,
  toKey: r.to_key as string,
  basisKind: r.basis_kind as WikiLink["basisKind"],
  basisId: r.basis_id as number,
});

/** The lines that name `key` as their end: its backlinks. */
export const listWikiBacklinks = (db: SqlDriver, key: string): WikiLink[] =>
  db
    .all("SELECT * FROM wiki_links WHERE to_key = ? ORDER BY from_key, basis_kind, basis_id", [key])
    .map(linkOf);

/** The lines `key` starts: the pages it points at. */
export const listWikiLinksFrom = (db: SqlDriver, key: string): WikiLink[] =>
  db
    .all("SELECT * FROM wiki_links WHERE from_key = ? ORDER BY to_key, basis_kind, basis_id", [key])
    .map(linkOf);

// ---- state ----------------------------------------------------------------------------------------

export interface WikiState {
  inputSeq: number;
  builtSeq: number;
  builtKnowledgeRevision: number;
  builtChangeSeq: number;
  forceSeq: number;
  forcedSeq: number;
}

export function readWikiState(db: SqlDriver): WikiState {
  const r = db.all("SELECT * FROM wiki_state WHERE id = 1")[0] as Record<string, number>;
  return {
    inputSeq: r.input_seq as number,
    builtSeq: r.built_seq as number,
    builtKnowledgeRevision: r.built_knowledge_revision as number,
    builtChangeSeq: r.built_change_seq as number,
    forceSeq: r.force_seq as number,
    forcedSeq: r.forced_seq as number,
  };
}

/** Whether a table the pages read changed since the last build caught up (K01-R5). */
export const isWikiStale = (db: SqlDriver): boolean => {
  const s = readWikiState(db);
  return s.inputSeq > s.builtSeq;
};

/**
 * Records a finished build, in the result's transaction: the pages are as of `inputSeq` (read before the
 * build began, so a change made while it ran leaves the Wiki stale) and `forcedSeq` of the rebuild requests.
 */
export function advanceWikiState(
  tx: SqlDriver,
  built: { inputSeq: number; forcedSeq: number },
): void {
  tx.run(
    `UPDATE wiki_state SET built_seq = ?, forced_seq = ?, built_knowledge_revision = ?, built_change_seq = ?
      WHERE id = 1`,
    [built.inputSeq, built.forcedSeq, readKnowledgeRevision(tx), readChangeSeq(tx)],
  );
}

export type WikiBuildRequest =
  | { status: "registered"; job: StoredJob }
  /** Nothing is behind. */
  | { status: "fresh" }
  /** A build is already open (queued, running, retrying or held). */
  | { status: "open" }
  /** The last build gave up and the input has not changed since: not asked again (K01-R5). */
  | { status: "dead" };

const TARGET_PREFIX = "seq:";

const isDeadAt = (db: SqlDriver, inputSeq: number): boolean => {
  const last = db.all("SELECT status, target FROM jobs WHERE kind = ? ORDER BY id DESC LIMIT 1", [
    WIKI_BUILD_KIND,
  ])[0];
  return (
    last?.status === "dead_letter" &&
    Number((last.target as string).slice(TARGET_PREFIX.length)) >= inputSeq
  );
};

/** Whether the Wiki is behind and the last build gave up on the input as it stands (K01-R5): nothing is retrying. */
export const isWikiBuildDead = (db: SqlDriver): boolean => {
  const { inputSeq, builtSeq } = readWikiState(db);
  return inputSeq > builtSeq && isDeadAt(db, inputSeq);
};

/**
 * Queues the one `wiki-build` job when the Wiki is stale (K01-R5). The job's target names the input
 * sequence it was asked at, so a dead letter is read against the sequence now. Call it in the transaction
 * that changed the input, or on its own: it writes only the job.
 */
export function requestWikiBuild(db: SqlDriver, at: Date = new Date()): WikiBuildRequest {
  return db.transaction(() => {
    const { inputSeq, builtSeq } = readWikiState(db);
    if (inputSeq <= builtSeq) return { status: "fresh" } as const;
    if (
      db.all(
        "SELECT 1 FROM jobs WHERE kind = ? AND status IN ('queued', 'running', 'retry', 'held')",
        [WIKI_BUILD_KIND],
      ).length > 0
    ) {
      return { status: "open" } as const;
    }
    if (isDeadAt(db, inputSeq)) return { status: "dead" } as const;
    const registered = registerJob(db, {
      kind: WIKI_BUILD_KIND,
      target: `${TARGET_PREFIX}${inputSeq}`,
      priority: "maintenance",
      at,
    });
    return registered.registered
      ? ({ status: "registered", job: registered.job } as const)
      : ({ status: "open" } as const);
  });
}

/** The user's "rebuild" (K01-R10): the next build rewrites every page; it also counts as a change of input. */
export function requestWikiRebuild(db: SqlDriver, at: Date = new Date()): WikiBuildRequest {
  return db.transaction(() => {
    db.run("UPDATE wiki_state SET force_seq = force_seq + 1, input_seq = input_seq + 1");
    return requestWikiBuild(db, at);
  });
}

// ---- the user's edits (K01-R11) --------------------------------------------------------------------

export interface WikiNote {
  id: number;
  pageKey: string;
  text: string;
  at: string;
}

const noteOf = (r: Record<string, unknown>): WikiNote => ({
  id: r.id as number,
  pageKey: r.page_key as string,
  text: r.note as string,
  at: r.at as string,
});

export function addWikiNote(db: SqlDriver, pageKey: string, text: string, at: string): number {
  return db.run("INSERT INTO wiki_edits (op, page_key, note, at) VALUES ('note', ?, ?, ?)", [
    pageKey,
    text,
    at,
  ]).lastInsertRowid;
}

export const removeWikiNote = (db: SqlDriver, id: number): boolean =>
  db.run("DELETE FROM wiki_edits WHERE id = ? AND op = 'note'", [id]).changes === 1;

export const listWikiNotes = (db: SqlDriver, pageKey?: string): WikiNote[] =>
  db
    .all(
      `SELECT id, page_key, note, at FROM wiki_edits WHERE op = 'note'
         ${pageKey === undefined ? "" : "AND page_key = ?"} ORDER BY id`,
      pageKey === undefined ? [] : [pageKey],
    )
    .map(noteOf);

export type WikiClaimRef = { kind: "fact" | "relation"; id: number };

/** Hides (or shows again) one fact or relation on every page that carries it. */
export function setWikiHide(db: SqlDriver, claim: WikiClaimRef, hidden: boolean, at: string): void {
  const column = claim.kind === "fact" ? "fact_id" : "relation_id";
  if (hidden) {
    db.run(`INSERT OR IGNORE INTO wiki_edits (op, ${column}, at) VALUES ('hide', ?, ?)`, [
      claim.id,
      at,
    ]);
  } else {
    db.run(`DELETE FROM wiki_edits WHERE op = 'hide' AND ${column} = ?`, [claim.id]);
  }
}

export const listWikiHidden = (db: SqlDriver): WikiClaimRef[] =>
  db
    .all("SELECT fact_id, relation_id FROM wiki_edits WHERE op = 'hide' ORDER BY id")
    .map((r) =>
      r.fact_id !== null
        ? { kind: "fact" as const, id: r.fact_id as number }
        : { kind: "relation" as const, id: r.relation_id as number },
    );

// ---- the LLM summary (K01-R12) ---------------------------------------------------------------------

export const readWikiSummary = (db: SqlDriver): boolean =>
  readSetting(db, WIKI_SUMMARY_SETTING) === "on";

/** Whether a `wiki-summary` job for `key` is held (a condition, such as consent, stops it). */
export const wikiSummaryHeld = (db: SqlDriver, key: string): boolean =>
  db.all(
    "SELECT 1 FROM jobs WHERE kind = ? AND status = 'held' AND substr(target, 1, length(?) + 1) = ? || '#'",
    [WIKI_SUMMARY_KIND, key, key],
  ).length > 0;

/**
 * Queues one `wiki-summary` job per page whose summary is not of its current content (K01-R12), at most
 * WIKI_SUMMARY_BATCH, and returns how many. The job's target is `<key>#<content hash>`: ids only, and the
 * mark of the attempt. A page is left out when it is an Insight page, has no lineage or more than
 * WIKI_SUMMARY_MAX_VERSIONS versions, has an open job already, or was tried at this content (any status).
 * Nothing is queued while the setting is off.
 */
export function requestWikiSummaries(db: SqlDriver, at: Date = new Date()): number {
  if (!readWikiSummary(db)) return 0;
  return db.transaction(() => {
    const pages = db.all(
      `SELECT p.key AS key, p.content_hash AS hash FROM wiki_pages p
        WHERE p.kind <> 'syntheses'
          AND p.summary_hash IS NOT p.content_hash
          AND (SELECT count(*) FROM wiki_page_lineage l WHERE l.page_key = p.key) BETWEEN 1 AND ?
          AND NOT EXISTS (SELECT 1 FROM jobs j
                           WHERE j.kind = ? AND substr(j.target, 1, length(p.key) + 1) = p.key || '#'
                             AND (j.status IN ('queued', 'running', 'retry', 'held')
                                  OR j.target = p.key || '#' || p.content_hash))
        ORDER BY p.key LIMIT ?`,
      [WIKI_SUMMARY_MAX_VERSIONS, WIKI_SUMMARY_KIND, WIKI_SUMMARY_BATCH],
    );
    let queued = 0;
    for (const row of pages) {
      const registered = registerJob(db, {
        kind: WIKI_SUMMARY_KIND,
        target: `${row.key as string}#${row.hash as string}`,
        priority: "maintenance",
        at,
      });
      if (registered.registered) queued++;
    }
    return queued;
  });
}

/**
 * Stores the switch. From OFF to ON it queues the pages' summary jobs in the same transaction; ON to ON and
 * OFF queue nothing. Returns the jobs queued.
 */
export function setWikiSummary(db: SqlDriver, on: boolean, at: Date): number {
  return db.transaction(() => {
    const was = readWikiSummary(db);
    writeSetting(db, WIKI_SUMMARY_SETTING, on ? "on" : "off");
    return on && !was ? requestWikiSummaries(db, at) : 0;
  });
}
