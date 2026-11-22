// Applying the tombstone ledger again (I04-R17): at every start, before the API opens,
// and after a restore. Every line whose sequence is above the one the database has
// applied (and that no cancel record names) is carried over in sequence order, one
// transaction per line, as the line states it: no judging against the stored
// tombstone (the entries would raise a cover a restored database lowered, and queue a
// new line for it). A line that widens or creates the cover purges through the
// same propagation as the entries; a lift line moves the lift and nothing else (a
// lift deletes nothing and leaves no invalidation record, I04-T05). The line's sequence
// is written in the same transaction, so a failing line leaves its tombstone and its
// number as they were, and the start stops on it rather than skip a deletion.
import {
  canonicalTransaction,
  ensureSourceByHash,
  hashSourceIdentity,
  ledgerOf,
  LEDGER_REPORT_SETTING,
  readLedgerSeq,
  supersedeOpenJobs,
  writeLedgerSeq,
  writeSetting,
  writeTombstoneAsIs,
  type DerivativeRegistry,
  type LedgerLine,
  type SqlDriver,
  type TombstoneState,
} from "@pki/storage";
import { derivativeRegistry, propagateCanonical } from "./canonical-kinds.ts";

/** The ledger is not attached to the driver: nothing could have been written to it either. */
export class LedgerNotAttachedError extends Error {
  constructor() {
    super("no tombstone ledger is attached to the database");
    this.name = "LedgerNotAttachedError";
  }
}

/** One line could not be applied; the database holds the lines before it and none of its own. */
export class LedgerReapplyError extends Error {
  readonly seq: number;
  constructor(seq: number, cause: unknown) {
    super(`ledger line ${seq} could not be applied`, { cause });
    this.name = "LedgerReapplyError";
    this.seq = seq;
  }
}

export interface ReapplyReport {
  /** Lines carried over (lifts included). */
  applied: number;
  /** Of those, the lifts. */
  lifted: number;
  /** Lines at or below the database's sequence, or repeating a sequence already applied. */
  skipped: number;
  /** The database's applied sequence after the run. */
  canonicalSeq: number;
  /** The file ended in a cut line, cut off and not applied. */
  truncated: boolean;
  /** Complete lines that could not be read, not applied. */
  damaged: number;
  /** No ledger file although the database holds data: deletions after the backup are unknown. */
  missing: boolean;
  /** Ledgers set aside at this start (another installation's key) and their deletion counts. */
  setAside: { file: string; deletions: number; reason: "other-key" | "damaged-header" }[];
}

export type LedgerReapply = (db: SqlDriver) => ReapplyReport;

export function createLedgerReapply(registry: DerivativeRegistry): LedgerReapply {
  const applyLine = (db: SqlDriver, line: LedgerLine): void =>
    void canonicalTransaction(db, (tx) => {
      const sourceId = ensureSourceByHash(tx, line.connectorInstanceId, line.identityHash);
      const next: TombstoneState = {
        sourceId,
        coversVersion: line.coversVersion,
        lastRevision: line.lastRevision,
        reason: line.reason,
        at: line.at,
        liftedAt: line.liftedAt,
      };
      const old = writeTombstoneAsIs(tx, next);
      const same =
        old !== undefined &&
        old.coversVersion === next.coversVersion &&
        old.lastRevision === next.lastRevision &&
        old.reason === next.reason &&
        old.at === next.at &&
        old.liftedAt === next.liftedAt;
      if (line.liftedAt === null && !same) {
        supersedeOpenJobs(tx, sourceId, new Date(line.at));
        propagateCanonical(
          tx,
          {
            kind: line.reason,
            sourceId,
            coversVersion: line.coversVersion,
            lastRevision: line.lastRevision,
          },
          line.at,
          registry,
        );
        hashSourceIdentity(tx, sourceId);
      }
      writeLedgerSeq(tx, line.seq);
    });

  return (db) => {
    const ledger = ledgerOf(db);
    if (!ledger) throw new LedgerNotAttachedError();
    const contents = ledger.contents();
    const report: ReapplyReport = {
      applied: 0,
      lifted: 0,
      skipped: 0,
      canonicalSeq: readLedgerSeq(db),
      truncated: ledger.status.truncated,
      damaged: contents.damaged,
      missing: ledger.status.missing,
      setAside: ledger.status.setAside,
    };
    // sorted, stable: lines of one file are in sequence order, a hand-merged file may not be
    const lines = [...contents.lines].sort((a, b) => a.seq - b.seq);
    ledger.reconciling(() => {
      for (const line of lines) {
        if (line.seq <= readLedgerSeq(db)) {
          report.skipped++;
          continue;
        }
        try {
          applyLine(db, line);
        } catch (error) {
          throw new LedgerReapplyError(line.seq, error);
        }
        report.applied++;
        if (line.liftedAt !== null) report.lifted++;
      }
    });
    report.canonicalSeq = readLedgerSeq(db);
    // the data protection item reads this; held apart from the canonical write above
    writeSetting(db, LEDGER_REPORT_SETTING, JSON.stringify(report));
    return report;
  };
}

export const reapplyLedger: LedgerReapply = createLedgerReapply(derivativeRegistry);
