// The restore at start (H01-R11..R13): before the canonical database is opened, a marker staged by the restore
// API is applied by two renames, each of which leaves the data folder with one whole database file; after the
// ordinary start (prepare, ledger re-apply) one transaction finishes it; a start that fails in between puts the
// previous file back. The marker's state, not memory, says where a cut-off start stands, so every step can be
// run again. Only `pki.sqlite` changes: the lock, the ledger and the secrets file are not touched.
import type { EmbeddingSpace, VectorIndex } from "@pki/contracts";
import { ENGINE_KIND, VECTOR_KIND } from "@pki/knowledge-engine";
import {
  BEFORE_RESTORE_FILE,
  RESTORE_DIR,
  RESTORE_LAST_SETTING,
  STAGED_FILE,
  closeLocation,
  listLocations,
  readPending,
  readSetting,
  reclaimLeases,
  removeBackupTmp,
  removeRestoreArtifacts,
  syncPath,
  writePending,
  writeSetting,
  type OpenSqlDriver,
  type RestoreSummary,
  type SqlDriver,
} from "@pki/storage";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isReadable } from "./local-files-driver.ts";
import { requestProjectionRebuild } from "./projection-jobs.ts";

const DB_FILE = "pki.sqlite";

/** The step boundaries of the swap and the finish, where a test cuts the process off (H01-C2b). */
export type RestoreStep =
  | "marker-read"
  | "first-rename"
  | "second-rename"
  | "marker-swapped"
  | "before-commit"
  | "after-commit";

/** What a killed process is to the code: nothing after the step runs, no clean-up included. */
export class RestoreCrash extends Error {
  readonly step: RestoreStep;
  constructor(step: RestoreStep) {
    super(`restore cut off after ${step}`);
    this.name = "RestoreCrash";
    this.step = step;
  }
}

/** A test's way to stop the process after a step; the product passes none. */
export interface RestoreHooks {
  crashAfter?: RestoreStep;
}

const reach = (hooks: RestoreHooks | undefined, step: RestoreStep): void => {
  if (hooks?.crashAfter === step) throw new RestoreCrash(step);
};

export interface RestoreRun {
  dataDir: string;
  /** The restore this start carries out, whether it swapped just now or an earlier start did. */
  summary?: RestoreSummary;
  /** The database now at `pki.sqlite` is a restored one whose finish may not be committed. */
  applied: boolean;
  /** The finish is committed: a later failure no longer puts the previous file back. */
  finished: boolean;
  /** The open canonical database, set by the start so that a rollback closes it first. */
  db?: SqlDriver;
  /** A restore that failed earlier or could not start: its code, for the status API. */
  failedCode?: string;
}

const paths = (dataDir: string) => ({
  live: join(dataDir, DB_FILE),
  before: join(dataDir, BEFORE_RESTORE_FILE),
  staged: join(dataDir, RESTORE_DIR, STAGED_FILE),
  liveJournal: join(dataDir, `${DB_FILE}-journal`),
});

/**
 * A journal beside the live file means the last run died while writing it. SQLite rolls it back when the file
 * is first read, so the file is opened once and closed before it is renamed: a journal must never be left to
 * be applied to the file that takes its name.
 */
function settleJournal(dataDir: string, open: OpenSqlDriver): void {
  const { live, liveJournal } = paths(dataDir);
  if (!existsSync(liveJournal)) return;
  const db = open(live);
  try {
    db.all("SELECT count(*) AS n FROM sqlite_master");
  } finally {
    db.close();
  }
}

/** Puts the previous file back, from any state the swap can be in; each step can be run again. */
function undoSwap(dataDir: string): void {
  const { live, before, staged, liveJournal } = paths(dataDir);
  if (existsSync(before)) {
    rmSync(live, { force: true });
    rmSync(liveJournal, { force: true });
    renameSync(before, live);
  }
  rmSync(staged, { force: true });
  syncPath(dataDir);
}

/**
 * H01-R13: closes the database, undoes the swap and marks the restore `failed` (the code only, never a message).
 * The `rolling-back` mark goes first, so a start cut off in the middle finishes the undoing.
 */
export function rollbackRestore(run: RestoreRun, code = "start-failed"): void {
  run.db?.close();
  writePending(run.dataDir, { state: "rolling-back", code });
  undoSwap(run.dataDir);
  writePending(run.dataDir, { state: "failed", code });
}

/**
 * H01-R11: the swap, by the marker's state. Run it before the canonical database is opened. A step that
 * throws undoes what it did (a thrown `RestoreCrash` excepted: it stands for a process that is gone).
 */
export function applyPendingRestore(
  dataDir: string,
  open: OpenSqlDriver,
  hooks?: RestoreHooks,
): RestoreRun {
  const run: RestoreRun = { dataDir, applied: false, finished: false };
  removeBackupTmp(dataDir); // a snapshot a killed backup left: plaintext, never kept
  const marker = readPending(dataDir);
  if (!marker) {
    removeRestoreArtifacts(dataDir); // a staging that was cut off
    return run;
  }
  if (marker.state === "failed" || marker.state === "rolling-back") {
    if (marker.state === "rolling-back") {
      undoSwap(dataDir);
      writePending(dataDir, { state: "failed", code: marker.code });
    }
    return { ...run, failedCode: marker.code };
  }
  const { state, ...summary } = marker;
  run.summary = summary;
  reach(hooks, "marker-read");
  try {
    if (state === "staged" && !swap(dataDir, open, hooks)) {
      writePending(dataDir, { state: "failed", code: "staged-missing" });
      return { dataDir, applied: false, finished: false, failedCode: "staged-missing" };
    }
    run.applied = true;
    return run;
  } catch (error) {
    if (error instanceof RestoreCrash) throw error;
    rollbackRestore(run, "swap-failed");
    throw error;
  }
}

/** The renames for a `staged` marker, from whatever step the last start reached. False when nothing is staged. */
function swap(dataDir: string, open: OpenSqlDriver, hooks: RestoreHooks | undefined): boolean {
  const { live, before, staged } = paths(dataDir);
  const stagedHere = existsSync(staged);
  const beforeHere = existsSync(before);
  if (!stagedHere && !beforeHere) return false;
  if (stagedHere) {
    if (!beforeHere && existsSync(live)) {
      settleJournal(dataDir, open);
      renameSync(live, before);
      syncPath(dataDir);
      reach(hooks, "first-rename");
    } else if (beforeHere && existsSync(live)) {
      throw new Error("restore-state-inconsistent");
    }
    renameSync(staged, live);
    syncPath(dataDir);
    reach(hooks, "second-rename");
  }
  const marker = readPending(dataDir);
  if (marker?.state === "staged") writePending(dataDir, { ...marker, state: "swapped" });
  reach(hooks, "marker-swapped");
  return true;
}

/**
 * What the vector index says about itself, for a manifest and for the restore's comparison. An index that is
 * not bound or cannot answer has no space and no sequence: the answer is `null`, never a failure of the backup
 * or of the restore (the bound index of this build says "unavailable" by throwing).
 */
export async function readIndexFacts(
  index: Pick<VectorIndex, "embeddingSpace" | "appliedChangeSeq">,
): Promise<{ embeddingSpace: EmbeddingSpace | null; vectorIndexSeq: number | null }> {
  try {
    return {
      embeddingSpace: await index.embeddingSpace(),
      vectorIndexSeq: await index.appliedChangeSeq(),
    };
  } catch {
    return { embeddingSpace: null, vectorIndexSeq: null };
  }
}

/** What the last applied restore did (settings `restore.last`, H01-R12); the status API shows it once. */
export interface RestoreLast {
  backupId: string;
  stagedAt: string;
  appliedAt: string;
  backupCreatedAt: string;
  reapplied: number;
  pausedLocations: number;
  clearedConsents: number;
  embeddingSpaceDiffers: boolean;
}

export function readRestoreLast(db: SqlDriver): RestoreLast | undefined {
  const text = readSetting(db, RESTORE_LAST_SETTING);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as RestoreLast;
  } catch {
    return undefined;
  }
}

export interface FinishReport {
  /** How many deletions the ledger re-apply applied (`reapplyAtStart`). */
  reapplied: number;
  /** The index's embedding space now; compared with the backup's. */
  embeddingSpace: EmbeddingSpace | null;
  now: Date;
}

/**
 * H01-R12: one transaction. Running jobs go back by the ordinary reclaim whatever their lease says, the
 * consents are cleared (D9), both projections are asked to rebuild whatever their sequence says, and the numbers
 * are recorded. Once it has committed the previous file and the marker are removed. A finish the last start
 * already committed (found by its record) only removes them. Returns what was recorded.
 */
export function finishRestore(
  db: SqlDriver,
  run: RestoreRun,
  report: FinishReport,
  hooks?: RestoreHooks,
): RestoreLast | undefined {
  const { summary } = run;
  if (!summary) return undefined;
  let last = readRestoreLast(db);
  if (last?.backupId !== summary.backupId || last.stagedAt !== summary.stagedAt) {
    last = db.transaction(
      () => {
        const kinds = db.all("SELECT DISTINCT kind FROM jobs WHERE status = 'running'");
        reclaimLeases(db, {
          kinds: kinds.map((row) => row.kind as string),
          now: report.now,
          leaseMs: 60_000, // unused with ignoreExpiry; a real lease length keeps the clock-regression branch out of it
          ignoreExpiry: true,
        });
        // the restored rows say `active` for folders that may since be revoked ones (I02B-R34): paused here, in the
        // same commit as the record, so no start that is cut off afterwards leaves them read
        const readable = listLocations(db).filter(isReadable);
        for (const location of readable) closeLocation(db, location.id, "paused", "restored");
        const paused = readable.length;
        const clearedConsents = Number(db.all("SELECT count(*) AS n FROM consents")[0]?.n);
        db.run("DELETE FROM consents");
        for (const target of [ENGINE_KIND, VECTOR_KIND]) {
          requestProjectionRebuild(db, target, { at: report.now });
        }
        const recorded: RestoreLast = {
          backupId: summary.backupId,
          stagedAt: summary.stagedAt,
          appliedAt: report.now.toISOString(),
          backupCreatedAt: summary.backupCreatedAt,
          reapplied: report.reapplied,
          pausedLocations: paused,
          clearedConsents,
          embeddingSpaceDiffers:
            JSON.stringify(summary.embeddingSpace) !== JSON.stringify(report.embeddingSpace),
        };
        writeSetting(db, RESTORE_LAST_SETTING, JSON.stringify(recorded));
        return recorded;
      },
      { immediate: true, beforeCommit: () => reach(hooks, "before-commit") },
    );
  }
  run.finished = true;
  reach(hooks, "after-commit");
  rmSync(paths(run.dataDir).before, { force: true });
  removeRestoreArtifacts(run.dataDir);
  return last;
}
