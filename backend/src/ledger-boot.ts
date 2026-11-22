// The tombstone ledger at the backend's start (I04-R17): open it beside the canonical
// database, and, before the API opens or the runner starts, carry over every line the
// database has not seen. When the database may not match the projections (lines were
// applied, the ledger was missing, or another installation's ledger was set aside) both
// projections are rebuilt whatever their applied sequence says: a restored database can
// happen to carry the same sequence with different records (I03-T10's request).
import {
  ENGINE_KIND,
  VECTOR_KIND,
  createLedgerReapply,
  type ReapplyReport,
} from "@pki/knowledge-engine";
import {
  LEDGER_FILE,
  LedgerUnavailableError,
  attachLedger,
  nodeLedgerIo,
  openLedger,
  parseLedger,
  readKey,
  readLedgerSeq,
  readTombstoneState,
  sourceLedgerName,
  writeLedgerSeq,
  writeSetting,
  draftReadable,
  ledgerOf,
  type LedgerLineDraft,
  type TombstoneLedger,
  type TombstoneState,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { join } from "node:path";
import { applyConfiguredScopes, type ConnectorScopes } from "./connector-scopes.ts";
import { LEDGER_HISTORY_SETTING, readLedgerHistory, type HistoryName } from "./ledger-history.ts";
import { requestProjectionRebuild } from "./projection-jobs.ts";

export const ledgerPath = (dir: string): string => join(dir, LEDGER_FILE);

/** The ledger's key (the header of the file beside the database), before the database is prepared. */
export function readLedgerKey(dir: string): Uint8Array | undefined {
  let text: string | undefined;
  try {
    text = nodeLedgerIo.read(ledgerPath(dir));
  } catch (error) {
    throw new LedgerUnavailableError(error);
  }
  const key = text === undefined ? undefined : parseLedger(text).key;
  return key === undefined ? undefined : Uint8Array.from(Buffer.from(key, "hex"));
}

/** One draft per tombstone the database holds, states as they are (the seed and the heal). */
function tombstoneDrafts(db: SqlDriver): (LedgerLineDraft & { sourceId: number })[] {
  return db.all("SELECT source_id FROM tombstones ORDER BY source_id").map((row) => {
    const sourceId = row.source_id as number;
    const state = readTombstoneState(db, sourceId) as TombstoneState;
    return {
      sourceId,
      ...sourceLedgerName(db, sourceId),
      coversVersion: state.coversVersion,
      lastRevision: state.lastRevision,
      reason: state.reason,
      at: state.at,
      liftedAt: state.liftedAt,
    };
  });
}

/**
 * Opens the ledger of `dir` for a prepared database and attaches it: from here its transactions write
 * it. A ledger that has to be created (missing, or another installation's set aside) is created in one
 * atomic step with a line for every tombstone the database already holds (states as they are, numbered
 * after the database's number): otherwise a backup restored later would bring those deletions back and
 * nothing would apply them again. A ledger that exists but lacks a line for some tombstone (a seed a
 * crash cut off in an earlier build, or a hand-copied file) is completed the same way and reported.
 * If the ledger cannot be written the start fails: a deletion could not be made durable.
 */
export function attachDirectoryLedger(db: SqlDriver, dir: string): void {
  const key = readKey(db);
  if (!key) throw new Error("the prepared database has no identity key");
  const hasData = db.all("SELECT 1 FROM sources LIMIT 1").length > 0;
  const ledger = openLedger({
    path: ledgerPath(dir),
    key,
    canonicalSeq: readLedgerSeq(db),
    hasData,
    seed: () => tombstoneDrafts(db),
  });
  if (ledger.status.seededThrough > 0) writeLedgerSeq(db, ledger.status.seededThrough);
  attachLedger(db, ledger);
}

/**
 * Completes the ledger after the reconcile: a line for every tombstone it has none for (a seed a crash cut
 * off in an earlier build, a hand-copied file), states as they are. It runs strictly AFTER the re-apply:
 * it numbers its lines above the file's highest and records that number as the database's, which is true
 * only once every line of the file has been applied. Never before. Returns the lines written; if the
 * ledger cannot take them it locks (writes are refused, the status says degraded) and the start goes on.
 */
export function healFromDatabase(
  db: SqlDriver,
  ledger: TombstoneLedger,
): { healed: number; unwritable: number } {
  const contents = ledger.contents();
  const applied = readLedgerSeq(db);
  const held = new Set(contents.lines.map((l) => `${l.connectorInstanceId}\0${l.identityHash}`));
  const lacking = tombstoneDrafts(db).filter(
    (d) => !held.has(`${d.connectorInstanceId}\0${d.identityHash}`),
  );
  // a value the reader would reject is not written (it would be written again at every start): counted instead
  const missing = lacking.filter(draftReadable);
  const unwritable = lacking.length - missing.length;
  if (missing.length === 0) return { healed: 0, unwritable };
  try {
    // the guard: a line the database has not applied must not be passed over by the number written below
    if (contents.lines.some((l) => l.seq > applied)) {
      throw new Error("a ledger line is not applied: the database's number must not pass it");
    }
    const seqs = ledger.reserve(missing.length, applied);
    ledger.append(seqs, missing);
    writeLedgerSeq(db, seqs[seqs.length - 1] as number);
    return { healed: missing.length, unwritable };
  } catch {
    ledger.lock();
    return { healed: 0, unwritable };
  }
}

/** What forces a rebuild of the projections after the reconcile. */
export const needsRebuild = (report: ReapplyReport): boolean =>
  report.applied > 0 || report.missing || report.setAside.length > 0;

/** The history of what the ledger had to do, kept across starts (`tombstone-ledger.history`); see `ledger-status.ts`. */
function recordHistory(db: SqlDriver, report: ReapplyReport, at: string): void {
  const history = readLedgerHistory(db);
  const bump = (name: HistoryName, by: number) => {
    if (by <= 0) return;
    history[name] = { total: history[name].total + by, last: at };
  };
  bump("missingCreated", report.missing ? 1 : 0);
  bump("setAside", report.setAside.length);
  bump("unrecoverable", report.unrecoverable);
  bump("reapplied", report.applied);
  bump("seeded", report.seeded + report.healed);
  // a cut line is gone once cut; an unreadable complete line stays in the file, so only a rise is new
  bump(
    "ignoredLines",
    (report.truncated ? 1 : 0) + Math.max(0, report.damaged - history.damagedSeen),
  );
  history.damagedSeen = Math.max(history.damagedSeen, report.damaged);
  writeSetting(db, LEDGER_HISTORY_SETTING, JSON.stringify(history));
}

/**
 * Reconciles at start (R17 "시작할 때 맞춰 보기" and "재적용": the same function). Run it before
 * the server opens and the runner starts; a line that cannot be applied throws and the start stops.
 */
export function reapplyAtStart(
  db: SqlDriver,
  registry: DerivativeRegistry,
  now: number,
  knownKind?: (kind: string) => boolean,
  scopes?: ConnectorScopes,
): ReapplyReport {
  const ledger = ledgerOf(db);
  const report = createLedgerReapply(registry, {
    ...(knownKind && { knownKind }),
    afterReconcile: (d) => (ledger ? healFromDatabase(d, ledger) : { healed: 0, unwritable: 0 }),
  })(db);
  // an instance the re-apply registered gets the scope the deployment configured, like every other path (I01-R15)
  applyConfiguredScopes(db, scopes);
  recordHistory(db, report, new Date(now).toISOString());
  if (needsRebuild(report)) {
    for (const target of [ENGINE_KIND, VECTOR_KIND]) {
      requestProjectionRebuild(db, target, { at: new Date(now) });
    }
  }
  return report;
}
