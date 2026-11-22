// What the status API says about the tombstone ledger (I04-R17): the report of the last start's
// reconcile (a settings row), the live lock, and the ledgers set aside beside the data. Integers and
// fixed codes only: no identifier and no file name reaches the screen.
import type { StatusResponse } from "@pki/contracts";
import {
  LEDGER_REPORT_SETTING,
  ledgerOf,
  parseLedger,
  readSetting,
  type SqlDriver,
} from "@pki/storage";
import { readLedgerHistory } from "./ledger-history.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LedgerStatus = StatusResponse["dataProtection"]["ledger"];

const SET_ASIDE = /^tombstone-ledger\.(other-key|damaged)-[1-9][0-9]*\.jsonl$/;

/** The ledgers set aside in `dir` and the deletions they hold; read each time so the count stays shown. */
function setAsideIn(dir: string): { ledgers: number; deletions: number } {
  try {
    const files = readdirSync(dir).filter((f) => SET_ASIDE.test(f));
    const deletions = files.reduce(
      (sum, f) => sum + parseLedger(readFileSync(join(dir, f), "utf8")).lines.length,
      0,
    );
    return { ledgers: files.length, deletions };
  } catch {
    return { ledgers: 0, deletions: 0 };
  }
}

function historyOf(db: SqlDriver): LedgerStatus["history"] {
  const h = readLedgerHistory(db);
  return {
    missingCreated: h.missingCreated,
    setAside: h.setAside,
    unrecoverable: h.unrecoverable,
    ignoredLines: h.ignoredLines,
    reapplied: h.reapplied,
    seeded: h.seeded,
  };
}

export function ledgerStatus(db: SqlDriver, dataDir: string): LedgerStatus {
  const raw = readSetting(db, LEDGER_REPORT_SETTING);
  let report: Record<string, unknown> = {};
  try {
    if (raw !== undefined) report = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    report = {};
  }
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
  const setAside = setAsideIn(dataDir);
  return {
    state: ledgerOf(db)?.isLocked()
      ? "degraded"
      : report.missing === true
        ? "missing-created"
        : "ok",
    reapplied: count(report.applied),
    unrecoverable: count(report.unrecoverable),
    unwritable: count(report.unwritable),
    ignoredLines: count(report.damaged) + (report.truncated === true ? 1 : 0),
    setAsideLedgers: setAside.ledgers,
    setAsideDeletions: setAside.deletions,
    history: historyOf(db),
  };
}
