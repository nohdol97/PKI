// I02A-C5 / R2-R3: one path or byte string in, checked bytes out.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { win32 } from "node:path";
import { READ_CHUNK_BYTES, isInside, readInput } from "./input.ts";
import { DEFAULT_LIMITS, resolveLimits } from "./limits.ts";

const limits = (maxFileBytes: number) => resolveLimits({ maxFileBytes });
let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pki-input-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

const text = (n: number) => new Uint8Array(n).fill(0x61);
const makeFile = (rel: string, content: string | Uint8Array = "hello") => {
  const path = join(base, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};

describe("bytes input", () => {
  it("passes a size equal to maxFileBytes and keeps the name", async () => {
    const r = await readInput({ kind: "bytes", bytes: text(16), name: "a.txt" }, limits(16));
    expect(r).toMatchObject({ ok: true, name: "a.txt" });
    expect(r.ok && r.bytes.byteLength).toBe(16);
  });

  it("rejects one byte more with too-large", async () => {
    const r = await readInput({ kind: "bytes", bytes: text(17) }, limits(16));
    expect(r).toMatchObject({ ok: false, error: { code: "too-large" } });
  });

  it("uses the 50 MiB default", async () => {
    const r = await readInput({ kind: "bytes", bytes: text(8) }, DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
  });
});

describe("path input", () => {
  it("reads a regular file and keeps the path as the name", async () => {
    const path = makeFile("a.md", "한글");
    const r = await readInput({ kind: "path", path }, DEFAULT_LIMITS);
    expect(r.ok && Buffer.from(r.bytes).toString("utf8")).toBe("한글");
    expect(r).toMatchObject({ name: path });
  });

  it("passes a file of exactly maxFileBytes and rejects one byte more, reading nothing for the latter", async () => {
    const equal = makeFile("eq.txt", text(16));
    const over = makeFile("over.txt", text(17));
    expect(await readInput({ kind: "path", path: equal }, limits(16))).toMatchObject({ ok: true });
    const reads = await countReads(() => readInput({ kind: "path", path: over }, limits(16)));
    expect(reads.result).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(reads.bytes).toBe(0);
  });

  it("stops reading at the cap plus one chunk when the file is bigger than its reported size", async () => {
    const big = makeFile("big.bin", text(READ_CHUNK_BYTES * 5));
    const probe = await open(big);
    const proto = Object.getPrototypeOf(probe) as {
      stat: (...a: unknown[]) => Promise<{ size: number }>;
    };
    await probe.close();
    const realStat = proto.stat;
    vi.spyOn(proto, "stat").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const s = await realStat.apply(this, args);
      return Object.assign(s, { size: 1 });
    });
    const reads = await countReads(() => readInput({ kind: "path", path: big }, limits(16)));
    expect(reads.result).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(reads.bytes).toBeGreaterThan(0);
    expect(reads.bytes).toBeLessThanOrEqual(16 + READ_CHUNK_BYTES);
  });

  it("re-checks the file type on the opened handle (a file swapped for a non-regular one)", async () => {
    const path = makeFile("swapped.txt");
    const probe = await open(path);
    const proto = Object.getPrototypeOf(probe) as {
      stat: (...a: unknown[]) => Promise<{ isFile: () => boolean }>;
    };
    await probe.close();
    const realStat = proto.stat;
    vi.spyOn(proto, "stat").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const s = await realStat.apply(this, args);
      return Object.assign(s, { isFile: () => false });
    });
    const r = await readInput({ kind: "path", path }, DEFAULT_LIMITS);
    expect(r).toMatchObject({ ok: false, error: { code: "not-a-file" } });
  });

  it("reports a missing file as read-failed", async () => {
    const r = await readInput({ kind: "path", path: join(base, "nope.txt") }, DEFAULT_LIMITS);
    expect(r).toMatchObject({ ok: false, error: { code: "read-failed" } });
  });

  it("reports a directory as not-a-file", async () => {
    mkdirSync(join(base, "dir"));
    const r = await readInput({ kind: "path", path: join(base, "dir") }, DEFAULT_LIMITS);
    expect(r).toMatchObject({ ok: false, error: { code: "not-a-file" } });
  });

  it.skipIf(process.platform === "win32")(
    "reports a FIFO as not-a-file without opening it",
    async () => {
      const fifo = join(base, "pipe");
      execFileSync("mkfifo", [fifo]);
      const r = await readInput({ kind: "path", path: fifo }, DEFAULT_LIMITS);
      expect(r).toMatchObject({ ok: false, error: { code: "not-a-file" } });
    },
  );
});

describe("isInside with Windows path rules", () => {
  it("compares segments, treats another drive as outside, ignores case", () => {
    expect(isInside("C:\\data\\a", "C:\\data\\a\\f.txt", win32)).toBe(true);
    expect(isInside("C:\\data\\a", "C:\\data\\ab\\f.txt", win32)).toBe(false);
    expect(isInside("C:\\data\\a", "D:\\data\\a\\f.txt", win32)).toBe(false);
    expect(isInside("C:\\data\\a", "c:\\DATA\\A\\f.txt", win32)).toBe(true);
    expect(isInside("C:\\data\\a", "C:\\data\\x", win32)).toBe(false);
  });
});

describe("allowedRoot", () => {
  const read = (path: string, allowedRoot: string) =>
    readInput({ kind: "path", path, allowedRoot }, DEFAULT_LIMITS);

  it("accepts a file inside the root, nested too", async () => {
    const root = join(base, "root");
    const inner = makeFile("root/sub/a.txt");
    expect(await read(inner, root)).toMatchObject({ ok: true });
  });

  it("accepts a file whose name merely starts with two dots", async () => {
    const root = join(base, "root");
    const dots = makeFile("root/..hidden.txt");
    expect(await read(dots, root)).toMatchObject({ ok: true });
  });

  it("rejects a sibling directory whose name starts with the root's name", async () => {
    const root = join(base, "root-a");
    mkdirSync(root);
    const sibling = makeFile("root-ab/secret.txt");
    expect(await read(sibling, root)).toMatchObject({ ok: false, error: { code: "outside-root" } });
  });

  it("rejects a .. path that leaves the root", async () => {
    const root = join(base, "root");
    mkdirSync(join(root, "sub"), { recursive: true });
    const outside = makeFile("outside.txt");
    expect(await read(join(root, "sub", "..", "..", "outside.txt"), root)).toMatchObject({
      ok: false,
      error: { code: "outside-root" },
    });
    expect(outside).toBeTruthy();
  });

  it("rejects a symlink that points outside the root and follows one that points inside", async () => {
    const root = join(base, "root");
    mkdirSync(root);
    const outside = makeFile("outside.txt", "secret");
    const inside = makeFile("root/real.txt", "fine");
    symlinkSync(outside, join(root, "escape.txt"));
    symlinkSync(inside, join(root, "alias.txt"));
    expect(await read(join(root, "escape.txt"), root)).toMatchObject({
      ok: false,
      error: { code: "outside-root" },
    });
    const ok = await read(join(root, "alias.txt"), root);
    expect(ok.ok && Buffer.from(ok.bytes).toString()).toBe("fine");
  });

  it("rejects a symlinked directory inside the root that points outside", async () => {
    const root = join(base, "root");
    mkdirSync(root);
    makeFile("elsewhere/x.txt");
    symlinkSync(join(base, "elsewhere"), join(root, "link"));
    expect(await read(join(root, "link", "x.txt"), root)).toMatchObject({
      ok: false,
      error: { code: "outside-root" },
    });
  });

  it("resolves a root that is itself a symlink", async () => {
    makeFile("real-root/a.txt");
    symlinkSync(join(base, "real-root"), join(base, "root-link"));
    expect(await read(join(base, "real-root", "a.txt"), join(base, "root-link"))).toMatchObject({
      ok: true,
    });
  });

  it("checks the root before the file type: a directory outside the root is outside-root", async () => {
    const root = join(base, "root");
    mkdirSync(root);
    mkdirSync(join(base, "other"));
    expect(await read(join(base, "other"), root)).toMatchObject({
      ok: false,
      error: { code: "outside-root" },
    });
  });

  it("reports a missing root as read-failed", async () => {
    const path = makeFile("a.txt");
    expect(await read(path, join(base, "no-such-root"))).toMatchObject({
      ok: false,
      error: { code: "read-failed" },
    });
  });
});

async function countReads<T>(run: () => Promise<T>): Promise<{ result: T; bytes: number }> {
  const probe = await open(join(base, ".probe"), "w");
  const proto = Object.getPrototypeOf(probe) as {
    read: (...a: unknown[]) => Promise<{ bytesRead: number }>;
  };
  await probe.close();
  const realRead = proto.read;
  let bytes = 0;
  vi.spyOn(proto, "read").mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const r = await realRead.apply(this, args);
    bytes += r.bytesRead;
    return r;
  });
  const result = await run();
  return { result, bytes };
}
