// The ledger file (I04-R17): its format, how it opens (missing, another key, a cut last
// line), the numbers it hands out, and the real file operations.
import { memoryLedgerIo } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerLineDraft } from "./derivatives.ts";
import { nodeLedgerIo, openLedger, parseLedger } from "./tombstone-ledger.ts";

const KEY = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);
const hex = (k: Uint8Array) => Buffer.from(k).toString("hex");
const P = "/data/tombstone-ledger.jsonl";
const draft = (over: Partial<LedgerLineDraft> = {}): LedgerLineDraft => ({
  connectorInstanceId: "c1",
  identityHash: "h1",
  coversVersion: 2,
  lastRevision: null,
  reason: "user-deleted",
  at: "2026-11-22T00:00:00.000Z",
  liftedAt: null,
  ...over,
});
const open = (io = memoryLedgerIo(), over: Partial<Parameters<typeof openLedger>[0]> = {}) => ({
  io,
  ledger: openLedger({ path: P, key: KEY, canonicalSeq: 0, hasData: false, io, ...over }),
});

describe("ledger file format", () => {
  it("starts with the header that holds the key, and keeps no identifier in a line", () => {
    const { io, ledger } = open();
    ledger.append(ledger.reserve(1, 0), [draft()]);
    const [header, line] = (io.files.get(P) as string).trimEnd().split("\n");
    expect(JSON.parse(header as string)).toEqual({ t: "header", v: 1, key: hex(KEY) });
    expect(JSON.parse(line as string)).toEqual({
      t: "line",
      seq: 1,
      i: "c1",
      h: "h1",
      cv: 2,
      lr: null,
      reason: "user-deleted",
      at: "2026-11-22T00:00:00.000Z",
      la: null,
    });
  });

  it("reads lines back, leaves out cancelled ones, and counts the highest number cancel records included", () => {
    const { io, ledger } = open();
    ledger.append(ledger.reserve(2, 0), [draft(), draft({ identityHash: "h2" })]);
    ledger.cancel([2]);
    ledger.append(ledger.reserve(1, 0), [draft({ identityHash: "h3" })]);
    const read = parseLedger(io.files.get(P) as string);
    expect(read.lines.map((l) => [l.seq, l.identityHash])).toEqual([
      [1, "h1"],
      [3, "h3"],
    ]);
    expect(read.maxSeq).toBe(3);
    expect(read.truncated).toBe(false);
    expect(read.damaged).toBe(0);
  });

  it("ignores a last line without its newline, and counts a complete line it cannot read", () => {
    const whole = `${JSON.stringify({ t: "header", v: 1, key: hex(KEY) })}\n`;
    const good = JSON.stringify({
      t: "line",
      seq: 1,
      i: "c",
      h: "h",
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: "a",
      la: null,
    });
    const text = `${whole}${good}\n{"t":"line","seq":2\n${good.replace('"seq":1', '"seq":3')}`;
    const read = parseLedger(text);
    expect(read.lines.map((l) => l.seq)).toEqual([1]);
    expect(read.truncated).toBe(true);
    expect(read.damaged).toBe(1);
  });

  it("refuses a line that names an unknown reason or a negative cover", () => {
    const header = `${JSON.stringify({ t: "header", v: 1, key: "k" })}\n`;
    const base = {
      t: "line",
      seq: 1,
      i: "c",
      h: "h",
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: "a",
      la: null,
    };
    for (const bad of [{ reason: "gone" }, { cv: -1 }, { seq: 0 }, { la: 5 }]) {
      const read = parseLedger(`${header}${JSON.stringify({ ...base, ...bad })}\n`);
      expect(read.lines).toEqual([]);
      expect(read.damaged).toBe(1);
    }
  });
});

describe("numbers", () => {
  it("are above the file's last and the database's, and never given twice, cancelled ones included", () => {
    const { ledger } = open();
    expect(ledger.reserve(2, 0)).toEqual([1, 2]);
    expect(ledger.reserve(1, 0)).toEqual([3]); // the first two were reserved and never written
    expect(ledger.reserve(1, 10)).toEqual([11]); // the database is ahead of the file
  });

  it("continue after the file's last number at the next open, the cancel record's included", () => {
    const { io, ledger } = open();
    ledger.append(ledger.reserve(1, 0), [draft()]);
    ledger.cancel(ledger.reserve(2, 0));
    const next = open(io).ledger;
    expect(next.reserve(1, 0)).toEqual([4]);
  });
});

describe("opening", () => {
  it("creates a missing file with the key; the notice shows only when the database holds data", () => {
    for (const [canonicalSeq, hasData, missing] of [
      [0, false, false],
      [0, true, true],
      [3, false, true],
    ] as const) {
      const { io, ledger } = open(memoryLedgerIo(), { canonicalSeq, hasData });
      expect(ledger.status.missing).toBe(missing);
      expect(parseLedger(io.files.get(P) as string).key).toBe(hex(KEY));
    }
  });

  it("sets a ledger of another key aside, counts its deletions, and starts a new one", () => {
    const io = memoryLedgerIo();
    const foreign = open(io, { key: OTHER }).ledger;
    foreign.append(foreign.reserve(2, 0), [draft(), draft({ identityHash: "h2" })]);
    foreign.cancel([2]);
    const { ledger } = open(io);
    expect(ledger.status.setAside).toEqual([
      { file: "/data/tombstone-ledger.other-key-1.jsonl", deletions: 1, reason: "other-key" },
    ]);
    expect(parseLedger(io.files.get(P) as string).key).toBe(hex(KEY));
    expect(parseLedger(io.files.get(P) as string).lines).toEqual([]);
    // the foreign file stays, readable
    expect(
      parseLedger(io.files.get("/data/tombstone-ledger.other-key-1.jsonl") as string).lines,
    ).toHaveLength(1);
  });

  it("a second set-aside takes the next free name, so the first notice is not overwritten", () => {
    const io = memoryLedgerIo();
    for (let i = 0; i < 2; i++) {
      open(io, { key: OTHER });
      open(io);
    }
    expect([...io.files.keys()].sort()).toEqual([
      "/data/tombstone-ledger.jsonl",
      "/data/tombstone-ledger.other-key-1.jsonl",
      "/data/tombstone-ledger.other-key-2.jsonl",
      "/data/tombstone-ledger.other-key-3.jsonl",
    ]);
  });

  it("sets aside a file whose header cannot be read, deletions not counted as another key's", () => {
    const io = memoryLedgerIo();
    io.files.set(P, '{"t":"header","v":1,"ke');
    const { ledger } = open(io);
    expect(ledger.status.setAside).toMatchObject([{ reason: "damaged-header" }]);
    expect(parseLedger(io.files.get(P) as string).key).toBe(hex(KEY));
  });

  it("cuts a last line without its newline off the file and says so; the next line is whole", () => {
    const io = memoryLedgerIo();
    const first = open(io).ledger;
    first.append(first.reserve(1, 0), [draft()]);
    io.files.set(P, `${io.files.get(P)}{"t":"line","seq":2,"i":"c`);
    const { ledger } = open(io);
    expect(ledger.status.truncated).toBe(true);
    ledger.append(ledger.reserve(1, 0), [draft({ identityHash: "h9" })]);
    const read = parseLedger(io.files.get(P) as string);
    expect(read.lines.map((l) => l.seq)).toEqual([1, 2]);
    expect(read.damaged).toBe(0);
    expect(read.truncated).toBe(false);
  });
});

describe("lock", () => {
  it("holds until the reconcile that follows it ends, and a failing reconcile keeps it", () => {
    const { ledger } = open();
    ledger.lock();
    expect(ledger.isLocked()).toBe(true);
    expect(() =>
      ledger.reconciling(() => {
        expect(ledger.isLocked()).toBe(false);
        throw new Error("line failed");
      }),
    ).toThrow("line failed");
    expect(ledger.isLocked()).toBe(true);
    ledger.reconciling(() => undefined);
    expect(ledger.isLocked()).toBe(false);
  });
});

describe("the real files", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates, appends, cuts a cut line off, and sets aside through the node adapter", () => {
    dir = mkdtempSync(join(tmpdir(), "pki-ledger-io-"));
    const path = join(dir, "tombstone-ledger.jsonl");
    const ledger = openLedger({ path, key: KEY, canonicalSeq: 0, hasData: false });
    ledger.append(ledger.reserve(1, 0), [draft()]);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"t":"li`);
    const again = openLedger({ path, key: KEY, canonicalSeq: 0, hasData: false });
    expect(again.status.truncated).toBe(true);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    expect(nodeLedgerIo.read(join(dir, "none"))).toBeUndefined();
    const other = openLedger({ path, key: OTHER, canonicalSeq: 0, hasData: false });
    expect(other.status.setAside).toMatchObject([{ deletions: 1 }]);
    expect(nodeLedgerIo.exists(join(dir, "tombstone-ledger.other-key-1.jsonl"))).toBe(true);
  });
});
