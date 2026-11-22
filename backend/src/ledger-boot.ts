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
  type TombstoneLedger,
  type TombstoneState,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { join } from "node:path";
import { requestProjectionRebuild } from "./projection-jobs.ts";

export const ledgerPath = (dir: string): string => join(dir, LEDGER_FILE);

/** The ledger's key (the header of the file beside the database), before the database is prepared. */
export function readLedgerKey(dir: string): Uint8Array | undefined {
  const text = nodeLedgerIo.read(ledgerPath(dir));
  const key = text === undefined ? undefined : parseLedger(text).key;
  return key === undefined ? undefined : Uint8Array.from(Buffer.from(key, "hex"));
}

/** Opens the ledger of `dir` for a prepared database and attaches it: from here its transactions write it. */
export function attachDirectoryLedger(db: SqlDriver, dir: string): void {
  const key = readKey(db);
  if (!key) throw new Error("the prepared database has no identity key");
  const hasData = db.all("SELECT 1 FROM sources LIMIT 1").length > 0;
  const ledger = openLedger({
    path: ledgerPath(dir),
    key,
    canonicalSeq: readLedgerSeq(db),
    hasData,
  });
  if (ledger.status.created) seedFromDatabase(db, ledger);
  attachLedger(db, ledger);
}

/**
 * A ledger started over a database that already holds tombstones (the file was missing, or another
 * installation's was set aside) gets one line per tombstone, states carried as they are, numbered after
 * the database's number, before anything is served. Otherwise a backup restored later would bring those
 * deletions back, and nothing in the ledger would apply them again.
 */
function seedFromDatabase(db: SqlDriver, ledger: TombstoneLedger): void {
  const drafts = db.all("SELECT source_id FROM tombstones ORDER BY source_id").map((row) => {
    const sourceId = row.source_id as number;
    const state = readTombstoneState(db, sourceId) as TombstoneState;
    return {
      ...sourceLedgerName(db, sourceId),
      coversVersion: state.coversVersion,
      lastRevision: state.lastRevision,
      reason: state.reason,
      at: state.at,
      liftedAt: state.liftedAt,
    };
  });
  if (drafts.length === 0) return;
  const seqs = ledger.reserve(drafts.length, readLedgerSeq(db));
  ledger.append(seqs, drafts);
  writeLedgerSeq(db, seqs[seqs.length - 1] as number);
}

/** What forces a rebuild of the projections after the reconcile. */
export const needsRebuild = (report: ReapplyReport): boolean =>
  report.applied > 0 || report.missing || report.setAside.length > 0;

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
  if (needsRebuild(report)) {
    for (const target of [ENGINE_KIND, VECTOR_KIND]) {
      requestProjectionRebuild(db, target, { at: new Date(now) });
    }
  }
  return report;
}
