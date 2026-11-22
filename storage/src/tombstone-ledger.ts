// The tombstone ledger (I04-R17): an append-only file in the data directory, outside
// the canonical database and outside any backup, that holds one line for every
// write that changed a tombstone. After a restore of an older database the lines
// the database has not seen are applied again before anything is readable, so a
// deletion made after the backup does not come back.
//
// Format: JSON lines. The first line is the header with the identity key (hex), the
// rest are `line` records (the tombstone's state after the write, the source named
// by its connector instance and the keyed hash, never by its identifier) and
// `cancel` records (the sequence numbers of lines whose transaction did not commit).
// A last line without its newline is a write the process died in: ignored, never
// applied. A sequence number is never written twice, a cancelled one included.
//
// Files go through `LedgerIo`, so tests inject failures and the Windows-specific
// parts (directory fsync, rename over an existing name) sit in one adapter.
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LedgerLineDraft } from "./derivatives.ts";
import type { TombstoneReason } from "./tombstones.ts";

export const LEDGER_FILE = "tombstone-ledger.jsonl";
/** The setting that holds the last ledger sequence the canonical database has applied. */
export const LEDGER_SEQ_SETTING = "tombstone-ledger.seq";
/** The setting that holds the JSON of the last start's ledger report (the data protection item). */
export const LEDGER_REPORT_SETTING = "tombstone-ledger.report";

/** The file operations the ledger needs; each one is durable when it returns. */
export interface LedgerIo {
  /** The whole file, or undefined when it does not exist. */
  read(path: string): string | undefined;
  /** Appends and fsyncs the file; a created file also gets its directory fsynced. */
  append(path: string, text: string): void;
  /** Cuts the file to `bytes` and fsyncs it. */
  truncate(path: string, bytes: number): void;
  /** Renames `from` to a name that does not exist yet and fsyncs the directory. */
  rename(from: string, to: string): void;
  exists(path: string): boolean;
}

function fsyncDirectory(dir: string): void {
  // POSIX makes a created or renamed file durable only with its directory fsynced. Windows
  // cannot open a directory like this; there the call is skipped. Unverified on Windows (H01).
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const nodeLedgerIo: LedgerIo = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  append: (path, text) => {
    const created = !existsSync(path);
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) fsyncDirectory(dirname(path));
  },
  truncate: (path, bytes) => {
    truncateSync(path, bytes);
    const fd = openSync(path, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: (from, to) => {
    renameSync(from, to);
    fsyncDirectory(dirname(to));
  },
  exists: (path) => existsSync(path),
};

/** A ledger line as written: the draft, numbered. */
export interface LedgerLine {
  seq: number;
  connectorInstanceId: string;
  /** null for a line written before the kind was carried: it cannot recreate an unknown instance. */
  connectorKind: string | null;
  identityHash: string;
  coversVersion: number;
  lastRevision: number | null;
  reason: TombstoneReason;
  at: string;
  /** When the line's write lifted the tombstone; null for a deletion. */
  liftedAt: string | null;
}

export interface LedgerContents {
  /** The header's key (hex); undefined when the header is missing or damaged. */
  key: string | undefined;
  /** Lines that are not cancelled, in file order. */
  lines: LedgerLine[];
  /** The highest sequence in the file, cancel records included. */
  maxSeq: number;
  /** The last line had no newline: a write that was cut short, ignored. */
  truncated: boolean;
  /** Complete lines that could not be read; ignored. */
  damaged: number;
}

const REASONS: readonly string[] = ["user-deleted", "source-deleted", "access-revoked"];

const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function readLine(raw: unknown): LedgerLine | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (
    r.t !== "line" ||
    !isInt(r.seq) ||
    r.seq < 1 ||
    typeof r.i !== "string" ||
    !(r.k === undefined || typeof r.k === "string") ||
    typeof r.h !== "string" ||
    !isInt(r.cv) ||
    !(r.lr === null || isInt(r.lr)) ||
    typeof r.reason !== "string" ||
    !REASONS.includes(r.reason) ||
    typeof r.at !== "string" ||
    !(r.la === null || typeof r.la === "string")
  ) {
    return undefined;
  }
  return {
    seq: r.seq,
    connectorInstanceId: r.i,
    connectorKind: (r.k as string | undefined) ?? null,
    identityHash: r.h,
    coversVersion: r.cv,
    lastRevision: r.lr as number | null,
    reason: r.reason as TombstoneReason,
    at: r.at,
    liftedAt: r.la as string | null,
  };
}

export function parseLedger(text: string): LedgerContents {
  const pieces = text.split("\n");
  // the last piece is what follows the final newline: empty when the file ends whole
  const tail = pieces.pop() as string;
  const out: LedgerContents = {
    key: undefined,
    lines: [],
    maxSeq: 0,
    truncated: tail !== "",
    damaged: 0,
  };
  const cancelled = new Set<number>();
  pieces.forEach((piece, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(piece);
    } catch {
      raw = undefined;
    }
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (index === 0) {
      if (r.t === "header" && r.v === 1 && typeof r.key === "string") out.key = r.key;
      else out.damaged++;
      return;
    }
    if (r.t === "cancel" && Array.isArray(r.seqs) && r.seqs.every((s) => isInt(s) && s >= 1)) {
      for (const s of r.seqs as number[]) {
        cancelled.add(s);
        out.maxSeq = Math.max(out.maxSeq, s);
      }
      return;
    }
    const line = readLine(raw);
    if (!line) {
      out.damaged++;
      return;
    }
    out.maxSeq = Math.max(out.maxSeq, line.seq);
    out.lines.push(line);
  });
  out.lines = out.lines.filter((l) => !cancelled.has(l.seq));
  return out;
}

const hex = (key: Uint8Array) => Buffer.from(key).toString("hex");

const encodeLine = (seq: number, d: LedgerLineDraft) =>
  JSON.stringify({
    t: "line",
    seq,
    i: d.connectorInstanceId,
    k: d.connectorKind,
    h: d.identityHash,
    cv: d.coversVersion,
    lr: d.lastRevision,
    reason: d.reason,
    at: d.at,
    la: d.liftedAt,
  });

/** What opening the ledger found; the start-up reconcile reports it. */
export interface LedgerOpenStatus {
  /** A new file was started at this open (missing, or set aside): the database's tombstones are not in it yet. */
  created: boolean;
  /** No ledger file although the database holds data: deletions after the backup are unknown. */
  missing: boolean;
  /** The file ended in a cut line (a write the process died in); it was cut off, never applied. */
  truncated: boolean;
  /** Ledgers set aside because their key is not this database's, with the deletions each held. */
  setAside: { file: string; deletions: number; reason: "other-key" | "damaged-header" }[];
}

/** The ledger refuses writes: it could not write a cancel line (I04-R17 "취소 줄도 못 쓸 때"). */
export class LedgerDegradedError extends Error {
  readonly code = "ledger-degraded";
  constructor() {
    super("the tombstone ledger is locked until the next start's reconcile (ledger-degraded)");
    this.name = "LedgerDegradedError";
  }
}

export interface TombstoneLedger {
  readonly path: string;
  readonly status: LedgerOpenStatus;
  /** The file as it is now. */
  contents(): LedgerContents;
  /** Takes `count` sequence numbers above both the file's last and the database's; never given again. */
  reserve(count: number, canonicalSeq: number): number[];
  /** Appends the lines (one `fsync`); the numbers come from `reserve`. */
  append(seqs: readonly number[], drafts: readonly LedgerLineDraft[]): void;
  /** Appends a cancel record for these numbers; throws when it cannot (the caller locks). */
  cancel(seqs: readonly number[]): void;
  lock(): void;
  isLocked(): boolean;
  /** The reconcile writes while locked, then opens the ledger again. */
  reconciling<T>(fn: () => T): T;
}

export interface OpenLedgerOptions {
  path: string;
  /** The database's key. */
  key: Uint8Array;
  /** The last ledger sequence the database applied. */
  canonicalSeq: number;
  /** Whether the database holds any source or tombstone. */
  hasData: boolean;
  io?: LedgerIo;
}

function freeName(io: LedgerIo, path: string, label: string): string {
  for (let n = 1; ; n++) {
    const name = path.replace(/\.jsonl$/, `.${label}-${n}.jsonl`);
    if (!io.exists(name)) return name;
  }
}

/**
 * Opens the ledger of a data directory. A missing file is created with the
 * database's key; one whose key differs (another installation's backup) or whose
 * header cannot be read is set aside, kept for the notice that counts its deletions,
 * and a new one starts; a cut last line is cut off the file (it is reported by the
 * reconcile, which reads the file first).
 */
export function openLedger(options: OpenLedgerOptions): TombstoneLedger {
  const { path, key, io = nodeLedgerIo } = options;
  const header = `${JSON.stringify({ t: "header", v: 1, key: hex(key) })}\n`;
  const status: LedgerOpenStatus = {
    created: false,
    missing: false,
    truncated: false,
    setAside: [],
  };
  let lastSeq = 0;
  let locked = false;
  let reconcile = false;

  const text = io.read(path);
  if (text === undefined) {
    status.missing = options.canonicalSeq > 0 || options.hasData;
    status.created = true;
    io.append(path, header);
  } else {
    const found = parseLedger(text);
    if (found.key === undefined || found.key !== hex(key)) {
      const file = freeName(io, path, found.key === undefined ? "damaged" : "other-key");
      io.rename(path, file);
      status.setAside.push({
        file,
        deletions: found.lines.length,
        reason: found.key === undefined ? "damaged-header" : "other-key",
      });
      status.created = true;
      io.append(path, header);
    } else {
      lastSeq = found.maxSeq;
      if (found.truncated) {
        status.truncated = true;
        const whole = text.slice(0, text.lastIndexOf("\n") + 1);
        io.truncate(path, Buffer.byteLength(whole, "utf8"));
      }
    }
  }

  return {
    path,
    status,
    contents: () => parseLedger(io.read(path) ?? ""),
    reserve: (count, canonicalSeq) => {
      const first = Math.max(lastSeq, canonicalSeq) + 1;
      lastSeq = first + count - 1;
      return Array.from({ length: count }, (_, i) => first + i);
    },
    append: (seqs, drafts) => {
      io.append(path, drafts.map((d, i) => `${encodeLine(seqs[i] as number, d)}\n`).join(""));
    },
    cancel: (seqs) => {
      io.append(path, `${JSON.stringify({ t: "cancel", seqs })}\n`);
    },
    lock: () => {
      locked = true;
    },
    isLocked: () => locked && !reconcile,
    reconciling: (fn) => {
      reconcile = true;
      try {
        const result = fn();
        locked = false;
        return result;
      } finally {
        reconcile = false;
      }
    },
  };
}

/** The ledger a driver writes to when its canonical transactions commit (set by the composition root). */
const attached = new WeakMap<object, TombstoneLedger>();

export function attachLedger(db: object, ledger: TombstoneLedger): void {
  attached.set(db, ledger);
}

export function ledgerOf(db: object): TombstoneLedger | undefined {
  return attached.get(db);
}
