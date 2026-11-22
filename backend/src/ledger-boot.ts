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
  type LedgerLineDraft,
  type TombstoneLedger,
  type TombstoneState,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { join } from "node:path";
import { LEDGER_HISTORY_SETTING, readLedgerHistory, type HistoryName } from "./ledger-history.ts";
import { requestProjectionRebuild } from "./projection-jobs.ts";

export const ledgerPath = (dir: string): string => join(dir, LEDGER_FILE);

/** The ledger's key (the header of the file beside the database), before the database is prepared. */
export function readLedgerKey(dir: string): Uint8Array | undefined {
  const text = nodeLedgerIo.read(ledgerPath(dir));
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
  if (ledger.status.created) {
    if (ledger.status.seededThrough > 0) writeLedgerSeq(db, ledger.status.seededThrough);
  } else {
    healFromDatabase(db, ledger);
  }
  attachLedger(db, ledger);
}

function healFromDatabase(db: SqlDriver, ledger: TombstoneLedger): void {
  const held = new Set(
    ledger.contents().lines.map((l) => `${l.connectorInstanceId}\0${l.identityHash}`),
  );
  const missing = tombstoneDrafts(db).filter(
    (d) => !held.has(`${d.connectorInstanceId}\0${d.identityHash}`),
  );
  if (missing.length === 0) return;
  try {
    const seqs = ledger.reserve(missing.length, readLedgerSeq(db));
    ledger.append(seqs, missing);
    writeLedgerSeq(db, seqs[seqs.length - 1] as number);
    ledger.status.healed = missing.length;
  } catch {
    // the ledger cannot take them now: writes stay refused (degraded) until a start that can
    ledger.lock();
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
): ReapplyReport {
  const report = createLedgerReapply(registry)(db);
  recordHistory(db, report, new Date(now).toISOString());
  if (needsRebuild(report)) {
    for (const target of [ENGINE_KIND, VECTOR_KIND]) {
      requestProjectionRebuild(db, target, { at: new Date(now) });
    }
  }
  return report;
}
