// The ledger's real file operations (I04-R17), over a recording fs: a write that is short is
// finished or fails, the file is fsynced before the database commits and the directory after a
// create, the cut-line heal works on bytes, and a part-written line never swallows the next one.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { canonicalTransaction } from "./canonical-transaction.ts";
import type { LedgerLineDraft } from "./derivatives.ts";
import { migrate } from "./migrations.ts";
import { readSetting, writeSetting } from "./settings.ts";
import {
  attachLedger,
  createNodeLedgerIo,
  openLedger,
  parseLedger,
  realLedgerFs,
  type LedgerFs,
  type LedgerIo,
} from "./tombstone-ledger.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const hh = (s: string) => createHash("sha256").update(s).digest("hex");

/** An in-memory fs: files by path, directories by prefix; every call is logged. */
function memoryFs(options: { chunk?: number; stall?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const log: string[] = [];
  const open = new Map<number, string>();
  let next = 10;
  const fs: LedgerFs = {
    existsSync: (p) => files.has(p),
    openSync: (p, flags) => {
      log.push(`open:${p}:${flags}`);
      if (flags === "w" || !files.has(p)) files.set(p, Buffer.alloc(0));
      const fd = next++;
      open.set(fd, p);
      return fd;
    },
    writeSync: (fd, buffer, offset, length) => {
      const n = options.stall ? 0 : Math.min(length, options.chunk ?? length);
      log.push(`write:${n}`);
      const p = open.get(fd) as string;
      files.set(p, Buffer.concat([files.get(p) as Buffer, buffer.subarray(offset, offset + n)]));
      return n;
    },
    fsyncSync: (fd) => void log.push(`fsync:${open.get(fd)}`),
    closeSync: (fd) => void log.push(`close:${open.get(fd)}`),
    readFileSync: (p) => {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return f;
    },
    truncateSync: (p, bytes) => void files.set(p, (files.get(p) as Buffer).subarray(0, bytes)),
    renameSync: (from, to) => {
      log.push(`rename:${from}->${to}`);
      files.set(to, files.get(from) as Buffer);
      files.delete(from);
    },
    unlinkSync: (p) => {
      log.push(`unlink:${p}`);
      if (!files.delete(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
  return { fs, files, log };
}

const P = "/d/tombstone-ledger.jsonl";

describe("append", () => {
  it("finishes a short write: every byte is written, then the file is fsynced, then (new file) the directory", () => {
    const m = memoryFs({ chunk: 3 });
    createNodeLedgerIo(m.fs, "linux").append(P, "0123456789\n");
    expect((m.files.get(P) as Buffer).toString()).toBe("0123456789\n");
    expect(m.log.filter((l) => l.startsWith("write"))).toEqual([
      "write:3",
      "write:3",
      "write:3",
      "write:2",
    ]);
    expect(m.log.filter((l) => !l.startsWith("write"))).toEqual([
      `open:${P}:a`,
      `fsync:${P}`,
      `close:${P}`,
      "open:/d:r",
      "fsync:/d",
      "close:/d",
    ]);
  });

  it("throws when a write makes no progress, without fsyncing, and closes the file", () => {
    const m = memoryFs({ stall: true });
    expect(() => createNodeLedgerIo(m.fs, "linux").append(P, "abc\n")).toThrow(/no progress/);
    expect(m.log.some((l) => l.startsWith("fsync"))).toBe(false);
    expect(m.log).toContain(`close:${P}`);
  });

  it("does not fsync the directory when the file existed, nor on Windows", () => {
    const m = memoryFs();
    m.files.set(P, Buffer.alloc(0));
    createNodeLedgerIo(m.fs, "linux").append(P, "a\n");
    expect(m.log.some((l) => l.startsWith("open:/d:"))).toBe(false);
    const w = memoryFs();
    createNodeLedgerIo(w.fs, "win32").append(P, "a\n");
    expect(w.log.some((l) => l.startsWith("open:/d:"))).toBe(false);
    expect(w.log).toContain(`fsync:${P}`);
  });
});

describe("create", () => {
  it("writes a temp file, fsyncs it, renames it into place, then fsyncs the directory", () => {
    const m = memoryFs();
    createNodeLedgerIo(m.fs, "linux").create(P, "header\nline\n");
    expect((m.files.get(P) as Buffer).toString()).toBe("header\nline\n");
    expect(m.files.has(`${P}.tmp`)).toBe(false);
    expect(m.log.filter((l) => !l.startsWith("write"))).toEqual([
      `open:${P}.tmp:w`,
      `fsync:${P}.tmp`,
      `close:${P}.tmp`,
      `rename:${P}.tmp->${P}`,
      "open:/d:r",
      "fsync:/d",
      "close:/d",
    ]);
  });

  it("a crash before the rename leaves no ledger file, only the temp, and discardTemp removes it", () => {
    const m = memoryFs();
    const failing: LedgerFs = {
      ...m.fs,
      renameSync: () => {
        throw new Error("killed before the rename");
      },
    };
    expect(() => createNodeLedgerIo(failing, "linux").create(P, "x\n")).toThrow("killed");
    expect(m.files.has(P)).toBe(false);
    expect(m.files.has(`${P}.tmp`)).toBe(true);
    const io = createNodeLedgerIo(m.fs, "linux");
    io.discardTemp(P);
    expect(m.files.has(`${P}.tmp`)).toBe(false);
    io.discardTemp(P); // none left is fine
  });
});

describe("cutToLastNewline", () => {
  it("cuts on bytes: invalid UTF-8 in a whole line does not move the cut", () => {
    const m = memoryFs();
    const whole = Buffer.concat([Buffer.from('{"t":"header"}\n'), Buffer.from([0xff, 0xfe, 0x0a])]);
    m.files.set(P, Buffer.concat([whole, Buffer.from('{"t":"li')]));
    createNodeLedgerIo(m.fs, "linux").cutToLastNewline(P);
    expect(m.files.get(P)?.equals(whole)).toBe(true);
    expect(m.log).toContain(`fsync:${P}`);
  });
});

describe("through a canonical transaction", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-ledger-fs-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const draft = (hash: string): LedgerLineDraft => ({
    connectorInstanceId: "c1",
    connectorKind: "k1",
    identityHash: hh(hash),
    coversVersion: 1,
    lastRevision: null,
    reason: "user-deleted",
    at: "2026-11-22T00:00:00.000Z",
    liftedAt: null,
  });

  it("writes the line, fsyncs the file, and only then commits: the order write -> fsync -> COMMIT", () => {
    const events: string[] = [];
    const other = openBetterSqlite3(join(dir, "c.sqlite"), { busyTimeoutMs: 0 });
    const db = openBetterSqlite3(join(dir, "c.sqlite"));
    migrate(db);
    const spy: LedgerFs = {
      ...realLedgerFs,
      writeSync: (fd, b, o, l) => {
        events.push("write");
        return realLedgerFs.writeSync(fd, b, o, l);
      },
      fsyncSync: (fd) => {
        events.push(
          `fsync(visible=${String(other.all("SELECT 1 FROM settings WHERE key = 'w'").length)})`,
        );
        realLedgerFs.fsyncSync(fd);
      },
    };
    const path = join(dir, "tombstone-ledger.jsonl");
    const ledger = openLedger({
      path,
      key: new Uint8Array(32).fill(1),
      canonicalSeq: 0,
      hasData: false,
      io: createNodeLedgerIo(spy),
    });
    attachLedger(db, ledger);
    events.length = 0; // what the open did (the header) is not under test
    canonicalTransaction(db, (tx) => {
      writeSetting(tx, "w", "1");
      tx.queueLedgerLine(draft("a"));
    });
    // the file was written and fsynced while the row was not yet committed
    expect(events).toEqual(["write", "fsync(visible=0)"]);
    expect(readSetting(db, "w")).toBe("1");
    other.close();
    db.close();
  });

  it("a write that fails part-way: the transaction is undone, the fragment is one damaged line, and the next line is readable", () => {
    const db = freshDb();
    let text = "";
    let failNext = true;
    const io: LedgerIo = {
      read: () => text,
      append: (_p, t) => {
        if (failNext && t.includes('"line"')) {
          failNext = false;
          text += t.slice(0, 20); // a short write that then failed
          throw new Error("disk full");
        }
        text += t;
      },
      cutToLastNewline: () => undefined,
      rename: () => undefined,
      create: (_p, t) => void (text = t),
      discardTemp: () => undefined,
      exists: (p) => p === P && text !== "",
    };
    const ledger = openLedger({
      path: P,
      key: new Uint8Array(32).fill(1),
      canonicalSeq: 0,
      hasData: false,
      io,
    });
    attachLedger(db, ledger);
    expect(() =>
      canonicalTransaction(db, (tx) => {
        writeSetting(tx, "w", "1");
        tx.queueLedgerLine(draft("a"));
      }),
    ).toThrow("disk full");
    expect(readSetting(db, "w")).toBeUndefined();
    canonicalTransaction(db, (tx) => tx.queueLedgerLine(draft("b")));
    const read = parseLedger(text);
    expect(read.lines.map((l) => [l.seq, l.identityHash])).toEqual([[2, hh("b")]]);
    expect(read.damaged).toBe(1); // the fragment, kept apart
    expect(read.maxSeq).toBe(2); // the cancel record kept number 1 out of reuse
    db.close();
  });

  it("the line written right after a part-written one (no cancel between) is not swallowed by the fragment", () => {
    let text = "";
    let failNext = true;
    const io: LedgerIo = {
      read: () => text,
      append: (_p, t) => {
        if (failNext && t.includes('"line"')) {
          failNext = false;
          text += t.slice(0, 20);
          throw new Error("disk full");
        }
        text += t;
      },
      cutToLastNewline: () => undefined,
      rename: () => undefined,
      create: (_p, t) => void (text = t),
      discardTemp: () => undefined,
      exists: (p) => p === P && text !== "",
    };
    const ledger = openLedger({
      path: P,
      key: new Uint8Array(32).fill(1),
      canonicalSeq: 0,
      hasData: false,
      io,
    });
    expect(() => ledger.append(ledger.reserve(1, 0), [draft("a")])).toThrow("disk full");
    ledger.append(ledger.reserve(1, 0), [draft("b")]);
    expect(parseLedger(text).lines.map((l) => l.identityHash)).toEqual([hh("b")]);
  });

  it("a savepoint opened through the tx that rolls back takes the lines queued inside it", () => {
    const db = freshDb();
    let text = "";
    const io: LedgerIo = {
      read: () => text,
      append: (_p, t) => void (text += t),
      cutToLastNewline: () => undefined,
      rename: () => undefined,
      create: (_p, t) => void (text = t),
      discardTemp: () => undefined,
      exists: (p) => p === P && text !== "",
    };
    attachLedger(
      db,
      openLedger({ path: P, key: new Uint8Array(32).fill(1), canonicalSeq: 0, hasData: false, io }),
    );
    canonicalTransaction(db, (tx) => {
      tx.queueLedgerLine(draft("kept"));
      try {
        tx.transaction(() => {
          tx.queueLedgerLine(draft("rolled-back"));
          throw new Error("inner failed");
        });
      } catch {
        // the outer goes on
      }
    });
    expect(parseLedger(text).lines.map((l) => l.identityHash)).toEqual([hh("kept")]);
    db.close();
  });
});
