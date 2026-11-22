// The ledger file (I04-R17): its format, how it opens (missing, another key, a cut last
// line), the numbers it hands out, and the real file operations.
import { createHash } from "node:crypto";
import { memoryLedgerIo } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerLineDraft } from "./derivatives.ts";
import {
  LedgerUnavailableError,
  nodeLedgerIo,
  openLedger,
  parseLedger,
} from "./tombstone-ledger.ts";

const hh = (s: string) => createHash("sha256").update(s).digest("hex");

const KEY = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);
const hex = (k: Uint8Array) => Buffer.from(k).toString("hex");
const P = "/data/tombstone-ledger.jsonl";
const draft = (over: Partial<LedgerLineDraft> = {}): LedgerLineDraft => ({
  connectorInstanceId: "c1",
  connectorKind: "k1",
  identityHash: hh("h1"),
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
      k: "k1",
      h: hh("h1"),
      cv: 2,
      lr: null,
      reason: "user-deleted",
      at: "2026-11-22T00:00:00.000Z",
      la: null,
    });
  });

  it("reads lines back, leaves out cancelled ones, and counts the highest number cancel records included", () => {
    const { io, ledger } = open();
    ledger.append(ledger.reserve(2, 0), [draft(), draft({ identityHash: hh("h2") })]);
    ledger.cancel([2]);
    ledger.append(ledger.reserve(1, 0), [draft({ identityHash: hh("h3") })]);
    const read = parseLedger(io.files.get(P) as string);
    expect(read.lines.map((l) => [l.seq, l.identityHash])).toEqual([
      [1, hh("h1")],
      [3, hh("h3")],
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
      h: hh("h"),
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: "2026-11-22T00:00:00.000Z",
      la: null,
    });
    const text = `${whole}${good}\n{"t":"line","seq":2\n${good.replace('"seq":1', '"seq":3')}`;
    const read = parseLedger(text);
    expect(read.lines.map((l) => l.seq)).toEqual([1]);
    expect(read.truncated).toBe(true);
    expect(read.damaged).toBe(1);
  });

  it("counts a line that parses as JSON but has a field of the wrong type as damaged, field by field, and applies none", () => {
    const header = `${JSON.stringify({ t: "header", v: 1, key: "k" })}\n`;
    const base = {
      t: "line",
      seq: 1,
      i: "c",
      k: "k1",
      h: hh("h"),
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: "2026-11-22T00:00:00.000Z",
      la: null,
    };
    const bad: Record<string, unknown> = {
      seq: "1",
      i: 5,
      k: 5,
      h: 5,
      cv: "1",
      lr: "x",
      reason: 5,
      at: 5,
      la: 5,
    };
    for (const [field, value] of Object.entries(bad)) {
      const read = parseLedger(`${header}${JSON.stringify({ ...base, [field]: value })}\n`);
      expect([field, read.lines.length, read.damaged]).toEqual([field, 0, 1]);
    }
    for (const field of ["seq", "i", "h", "cv", "lr", "reason", "at", "la"]) {
      const rest = Object.fromEntries(Object.entries(base).filter(([k]) => k !== field));
      const read = parseLedger(`${header}${JSON.stringify(rest)}\n`);
      expect([field, read.lines.length, read.damaged]).toEqual([field, 0, 1]);
    }
  });

  it("refuses a line that names an unknown reason or a negative cover", () => {
    const header = `${JSON.stringify({ t: "header", v: 1, key: "k" })}\n`;
    const base = {
      t: "line",
      seq: 1,
      i: "c",
      h: hh("h"),
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: "2026-11-22T00:00:00.000Z",
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
    foreign.append(foreign.reserve(2, 0), [draft(), draft({ identityHash: hh("h2") })]);
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
    ledger.append(ledger.reserve(1, 0), [draft({ identityHash: hh("h9") })]);
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

describe("creating a ledger over a database that holds tombstones", () => {
  const seed = [draft(), draft({ identityHash: hh("h2"), liftedAt: "2026-11-23T00:00:00.000Z" })];

  it("writes the header and one line per tombstone in the one atomic step, numbered after the database's number", () => {
    const { io, ledger } = open(memoryLedgerIo(), {
      canonicalSeq: 4,
      hasData: true,
      seed: () => seed,
    });
    expect(io.log.filter((l) => l.startsWith("create"))).toEqual([`create:${P}`]);
    expect(io.log.some((l) => l.startsWith("append"))).toBe(false);
    const read = parseLedger(io.files.get(P) as string);
    expect(read.key).toBe(hex(KEY));
    expect(read.lines.map((l) => [l.seq, l.identityHash, l.liftedAt !== null])).toEqual([
      [5, hh("h1"), false],
      [6, hh("h2"), true],
    ]);
    expect(ledger.status).toMatchObject({ created: true, seeded: 2, seededThrough: 6 });
    expect(ledger.reserve(1, 4)).toEqual([7]);
  });

  it("a creation that fails leaves no file, and the next start creates it with the seed", () => {
    const io = memoryLedgerIo();
    io.fail = (op) => (op === "create" ? new Error("disk full") : undefined);
    expect(() =>
      openLedger({ path: P, key: KEY, canonicalSeq: 0, hasData: true, seed: () => seed, io }),
    ).toThrow(LedgerUnavailableError);
    expect(io.files.has(P)).toBe(false);
    io.fail = () => undefined;
    const again = openLedger({
      path: P,
      key: KEY,
      canonicalSeq: 0,
      hasData: true,
      seed: () => seed,
      io,
    });
    expect(again.status.seeded).toBe(2);
    expect(parseLedger(io.files.get(P) as string).lines).toHaveLength(2);
  });

  it("a temp file a crash left is removed at the next open, and the ledger is created with its seed", () => {
    const io = memoryLedgerIo();
    io.files.set(`${P}.tmp`, "half a ledger");
    const ledger = openLedger({
      path: P,
      key: KEY,
      canonicalSeq: 0,
      hasData: true,
      seed: () => seed,
      io,
    });
    expect(io.files.has(`${P}.tmp`)).toBe(false);
    expect(ledger.status.seeded).toBe(2);
  });

  it("a ledger that already exists is not seeded again", () => {
    const io = memoryLedgerIo();
    open(io, { seed: () => seed });
    let called = false;
    const again = open(io, { seed: () => ((called = true), seed) }).ledger;
    expect(called).toBe(false);
    expect(again.status.created).toBe(false);
  });
});

describe("a line may not make a start fail: value domains", () => {
  const header = `${JSON.stringify({ t: "header", v: 1, key: "k" })}\n`;
  const base = {
    t: "line",
    seq: 1,
    i: "c",
    k: "k1",
    h: hh("h"),
    cv: 1,
    lr: null,
    reason: "user-deleted",
    at: "2026-11-22T00:00:00.000Z",
    la: null,
  };
  const bad: [string, unknown][] = [
    ["at", "not a date"],
    ["at", ""],
    ["la", "yesterday"],
    ["cv", 1e13],
    ["lr", 1e13],
    ["seq", 1e13],
    ["i", ""],
    ["h", ""],
    ["h", "abc"],
    ["h", "A".repeat(64)],
    ["h", "0".repeat(65)],
    ["k", "Bad Kind"],
    ["k", ""],
    ["i", "x".repeat(300)],
    ["at", "2026-11-22T00:00:00.000Z".repeat(4)],
  ];
  it.each(bad)("a line whose %s is %j is damaged, skipped, and applies nothing", (field, value) => {
    const read = parseLedger(`${header}${JSON.stringify({ ...base, [field]: value })}\n`);
    expect([read.lines.length, read.damaged]).toEqual([0, 1]);
  });
  it("accepts the legacy line without a kind, and a null kind", () => {
    const legacy = Object.fromEntries(Object.entries(base).filter(([key]) => key !== "k"));
    for (const line of [legacy, { ...base, k: null }]) {
      const read = parseLedger(`${header}${JSON.stringify(line)}\n`);
      expect(read.lines.map((l) => l.connectorKind)).toEqual([null]);
    }
  });
  it("does not count an empty line (a write that failed before any byte)", () => {
    const read = parseLedger(`${header}\n${JSON.stringify(base)}\n\n`);
    expect([read.lines.length, read.damaged]).toEqual([1, 0]);
  });
  it("two lines with the same number and different content: the second is unreadable, not silently skipped; an exact repeat is kept (the re-apply skips it)", () => {
    const first = { ...base, seq: 4 };
    const other = { ...base, seq: 4, cv: 9 };
    const text = (...lines: object[]) =>
      header + lines.map((l) => `${JSON.stringify(l)}\n`).join("");
    const contradiction = parseLedger(text(first, other));
    expect(contradiction.lines.map((l) => l.coversVersion)).toEqual([1]);
    expect(contradiction.damaged).toBe(1);
    const repeat = parseLedger(text(first, first));
    expect([repeat.lines.length, repeat.damaged]).toEqual([2, 0]);
  });
});
