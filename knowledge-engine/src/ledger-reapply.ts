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
//
// A line whose instance the database does not know, and that carries no kind (or one this
// build does not know) to register it with, cannot be applied yet (I04-R20): its number is
// taken and it waits in the deferred list (`tombstone-ledger.deferred`, written in the same
// transaction as the number). Every start looks at the deferred lines again, together with
// the lines above the number, in sequence order: one whose instance or kind is known by now
// is applied (the number is never lowered), one a later line of the same source has already
// overtaken is dropped, one the file no longer has is dropped, the rest stay.
import {
  canonicalTransaction,
  ensureSourceByHash,
  hashSourceIdentity,
  ledgerOf,
  LEDGER_REPORT_SETTING,
  readConnectorKind,
  readLedgerSeq,
  readSetting,
  registerConnectorInstance,
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

/** The sequence numbers of the lines that wait: ascending JSON array, a counterpart of `tombstone-ledger.seq`. */
export const LEDGER_DEFERRED_SETTING = "tombstone-ledger.deferred";

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
  /** Lines waiting at the end of the run: their instance is unknown to the database and they carry no kind this build knows to register it with. Their numbers are taken; they are applied once the kind or instance is known. */
  unrecoverable: number;
  /** Of those, the lines that began to wait in this run (a line is never counted twice). */
  newlyDeferred: number;
  /** Tombstones the seed or the heal left out because their line would not be readable. */
  unwritable: number;
  /** Lines written to the ledger for tombstones it had no line for (a seed that was lost). */
  healed: number;
  /** Lines at or below the database's sequence, or repeating a sequence already applied; waiting lines dropped as overtaken or gone from the file. */
  skipped: number;
  /** The database's applied sequence after the run. */
  canonicalSeq: number;
  /** The file ended in a cut line, cut off and not applied. */
  truncated: boolean;
  /** Complete lines that could not be read, not applied. */
  damaged: number;
  /** Lines a new ledger was created with, and lines written for tombstones the ledger lacked: tombstones now in the ledger that were not. */
  seeded: number;
  /** No ledger file although the database holds data: deletions after the backup are unknown. */
  missing: boolean;
  /** Ledgers set aside at this start (another installation's key) and their deletion counts. */
  setAside: { file: string; deletions: number; reason: "other-key" | "damaged-header" }[];
}

export type LedgerReapply = (db: SqlDriver) => ReapplyReport;

export interface ReapplyOptions {
  /** Whether a connector kind is one the composition knows; a line naming another is never used to register an instance. */
  knownKind?: (kind: string) => boolean;
  /** Runs once the lines are applied (the database and the ledger agree up to the file's highest); returns lines written. */
  afterReconcile?: (db: SqlDriver) => { healed: number; unwritable: number };
  /** Runs inside the transaction of every line that was applied (not a deferred or pending one). */
  onApplied?: (tx: SqlDriver) => void;
}

const sourceKey = (line: LedgerLine): string => `${line.connectorInstanceId}\0${line.identityHash}`;

/** The list as stored, or undefined when the row is absent or is not an array of positive integers. */
function parseDeferred(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((v) => Number.isSafeInteger(v) && v > 0)) {
      return value as number[];
    }
  } catch {
    // not JSON: recomputed
  }
  return undefined;
}

const encodeDeferred = (seqs: ReadonlySet<number>): string =>
  JSON.stringify([...seqs].sort((a, b) => a - b));

type Outcome = { result: "applied" | "deferred" | "pending"; registered: boolean };

export function createLedgerReapply(
  registry: DerivativeRegistry,
  options: ReapplyOptions = {},
): LedgerReapply {
  /**
   * One line in one transaction. `waiting` is the list as it stands; the list written here is its
   * next state, in the same transaction as everything else, so a failure leaves both as they were.
   * A waiting line is applied without touching the applied number (it is below it).
   */
  const applyLine = (
    db: SqlDriver,
    line: LedgerLine,
    waiting: ReadonlySet<number>,
    wasWaiting: boolean,
    plainIndex: Map<string, Map<string, number>>,
  ): Outcome =>
    canonicalTransaction(db, (tx): Outcome => {
      let registered = false;
      if (readConnectorKind(tx, line.connectorInstanceId) === undefined) {
        // the source row needs its instance (a foreign key): the real kind, never a placeholder
        if (line.connectorKind === null || options.knownKind?.(line.connectorKind) === false) {
          if (wasWaiting) return { result: "pending", registered };
          writeLedgerSeq(tx, line.seq);
          writeSetting(tx, LEDGER_DEFERRED_SETTING, encodeDeferred(new Set(waiting).add(line.seq)));
          return { result: "deferred", registered };
        }
        registerConnectorInstance(tx, line.connectorInstanceId, line.connectorKind);
        registered = true;
      }
      const sourceId = ensureSourceByHash(
        tx,
        line.connectorInstanceId,
        line.identityHash,
        plainIndex,
      );
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
      if (wasWaiting) {
        const rest = new Set(waiting);
        rest.delete(line.seq);
        writeSetting(tx, LEDGER_DEFERRED_SETTING, encodeDeferred(rest));
      } else {
        writeLedgerSeq(tx, line.seq);
      }
      options.onApplied?.(tx);
      return { result: "applied", registered };
    });

  /** The list the run starts from: the stored one, or (absent, unreadable) the lines below the number whose instance is unknown. */
  const loadWaiting = (
    db: SqlDriver,
    lines: readonly LedgerLine[],
    applied: number,
  ): Set<number> => {
    const stored = parseDeferred(readSetting(db, LEDGER_DEFERRED_SETTING));
    if (stored !== undefined) {
      const waiting = new Set(stored.filter((seq) => seq <= applied));
      if (waiting.size !== stored.length) {
        writeSetting(db, LEDGER_DEFERRED_SETTING, encodeDeferred(waiting));
      }
      return waiting;
    }
    // applying a line registers its instance in the same transaction and no product path deletes an
    // instance: a line whose instance is unknown was never applied (this includes what an older build skipped)
    const unknown = new Map<string, boolean>();
    const isUnknown = (instance: string): boolean => {
      let known = unknown.get(instance);
      if (known === undefined) {
        known = readConnectorKind(db, instance) === undefined;
        unknown.set(instance, known);
      }
      return known;
    };
    const waiting = new Set(
      lines.filter((l) => l.seq <= applied && isUnknown(l.connectorInstanceId)).map((l) => l.seq),
    );
    writeSetting(db, LEDGER_DEFERRED_SETTING, encodeDeferred(waiting));
    return waiting;
  };

  return (db) => {
    const ledger = ledgerOf(db);
    if (!ledger) throw new LedgerNotAttachedError();
    const contents = ledger.contents();
    const report: ReapplyReport = {
      applied: 0,
      lifted: 0,
      skipped: 0,
      unrecoverable: 0,
      newlyDeferred: 0,
      canonicalSeq: readLedgerSeq(db),
      truncated: ledger.status.truncated,
      damaged: contents.damaged,
      seeded: ledger.status.seeded,
      healed: 0,
      unwritable: 0,
      missing: ledger.status.missing,
      setAside: ledger.status.setAside,
    };
    // sorted, stable: lines of one file are in sequence order, a hand-merged file may not be
    const lines = [...contents.lines].sort((a, b) => a.seq - b.seq);
    const waiting = loadWaiting(db, lines, report.canonicalSeq);
    ledger.reconciling(() => {
      const drop = (seq: number): void => {
        waiting.delete(seq);
        writeSetting(db, LEDGER_DEFERRED_SETTING, encodeDeferred(waiting));
        report.skipped++;
      };
      const inFile = new Set(lines.map((l) => l.seq));
      for (const seq of [...waiting]) if (!inFile.has(seq)) drop(seq);
      const bySource = new Map<string, LedgerLine[]>();
      if (waiting.size > 0) {
        for (const line of lines) {
          const same = bySource.get(sourceKey(line));
          if (same) same.push(line);
          else bySource.set(sourceKey(line), [line]);
        }
      }
      // a line of the same source above this one that the database already reflects carries the whole state
      const overtaken = (line: LedgerLine): boolean => {
        const applied = readLedgerSeq(db);
        return (bySource.get(sourceKey(line)) ?? []).some(
          (o) => o.seq > line.seq && o.seq <= applied && !waiting.has(o.seq),
        );
      };
      // the plain sources' hashes, built on a first miss and dropped with the run (F123-R2)
      const plainIndex = new Map<string, Map<string, number>>();
      let registered = false;
      const carry = (line: LedgerLine, wasWaiting: boolean): void => {
        let outcome: Outcome;
        try {
          outcome = applyLine(db, line, waiting, wasWaiting, plainIndex);
        } catch (error) {
          throw new LedgerReapplyError(line.seq, error);
        }
        registered ||= outcome.registered;
        if (outcome.result === "deferred") {
          waiting.add(line.seq);
          report.newlyDeferred++;
        } else if (outcome.result === "applied") {
          if (wasWaiting) waiting.delete(line.seq);
          report.applied++;
          if (line.liftedAt !== null) report.lifted++;
        }
      };
      const carryWaiting = (line: LedgerLine): void => {
        if (overtaken(line)) drop(line.seq);
        else carry(line, true);
      };
      for (const line of lines) {
        if (waiting.has(line.seq)) carryWaiting(line);
        else if (line.seq <= readLedgerSeq(db)) report.skipped++;
        else carry(line, false);
      }
      // an instance registered above may be the one an earlier waiting line was waiting for
      if (registered) {
        for (const line of lines) if (waiting.has(line.seq)) carryWaiting(line);
      }
    });
    const after = options.afterReconcile?.(db) ?? { healed: 0, unwritable: 0 };
    report.healed = after.healed;
    // a ledger just created counted its tombstones in the seed; the heal sees the same ones again
    report.unwritable = ledger.status.created ? ledger.status.unwritable : after.unwritable;
    report.unrecoverable = waiting.size;
    report.canonicalSeq = readLedgerSeq(db);
    // the data protection item reads this; held apart from the canonical write above
    writeSetting(db, LEDGER_REPORT_SETTING, JSON.stringify(report));
    return report;
  };
}

export const reapplyLedger: LedgerReapply = createLedgerReapply(derivativeRegistry);
