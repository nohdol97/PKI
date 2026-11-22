// What the tombstone ledger had to do, kept across starts (I04-R17): the status API's current state
// may return to `ok`, but a deletion that was not re-applied or a ledger that was made anew must not
// silently vanish from the screen. One settings row, counters and the time of the last occurrence.
import { readSetting, type SqlDriver } from "@pki/storage";

export const LEDGER_HISTORY_SETTING = "tombstone-ledger.history";

export type HistoryName =
  "missingCreated" | "setAside" | "unrecoverable" | "ignoredLines" | "reapplied" | "seeded";

export interface HistoryEntry {
  total: number;
  /** ISO time of the start at which it last happened; null while it never did. */
  last: string | null;
}

export type LedgerHistory = Record<HistoryName, HistoryEntry> & {
  /** The most unreadable complete lines one start has seen (they stay in the file), so a start does not count them again. */
  damagedSeen: number;
};

const NAMES: readonly HistoryName[] = [
  "missingCreated",
  "setAside",
  "unrecoverable",
  "ignoredLines",
  "reapplied",
  "seeded",
];

const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

export function readLedgerHistory(db: SqlDriver): LedgerHistory {
  let raw: Record<string, unknown> = {};
  try {
    const text = readSetting(db, LEDGER_HISTORY_SETTING);
    if (text !== undefined) raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const history = { damagedSeen: count(raw.damagedSeen) } as LedgerHistory;
  for (const name of NAMES) {
    const entry = (raw[name] ?? {}) as Record<string, unknown>;
    history[name] = {
      total: count(entry.total),
      last: typeof entry.last === "string" ? entry.last : null,
    };
  }
  return history;
}
