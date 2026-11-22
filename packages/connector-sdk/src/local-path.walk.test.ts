// I02B-T02 (I02B-R6, R47; I02B-C4 at the module level): walking a location and reading a file in
// the one order the spec gives, on real folders, symlinks, FIFOs and renames of this OS. The swaps
// are put at exact points between the steps (through a wrapped file system) so that each later
// comparison is shown to catch its swap; nothing here races. Swaps that go back before the check
// (I02B-R47's "does not give") are not tested and not claimed. Windows behaviour is not tested here.
import { execFileSync } from "node:child_process";
import {
  constants as fsConstants,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nodeBoundaryFs,
  readLocationFile,
  resolveExcluded,
  walkLocation,
  type BoundaryFs,
  type ExcludedFolder,
  type WalkEvent,
  type WalkOptions,
} from "./local-path.ts";

let base: string; // the scratch folder: holds the location ("loc") and the outside ("out")
let loc: string;
let out: string;
const OUTSIDE = "OUTSIDE-MARKER-9f3a";
const INSIDE = "inside-content";

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "pki-walk-")));
  loc = join(base, "loc");
  out = join(base, "out");
  mkdirSync(loc);
  mkdirSync(out);
  writeFileSync(join(out, "secret.txt"), OUTSIDE);
});
afterEach(() => {
  try {
    chmodSync(join(loc, "locked"), 0o700);
  } catch {
    /* not made */
  }
  rmSync(base, { recursive: true, force: true });
});

const limits = { maxDepth: 32, maxRelativePathChars: 1024 };
const noIgnore = () => false;

async function collect(options: Partial<WalkOptions> = {}): Promise<WalkEvent[]> {
  const events: WalkEvent[] = [];
  for await (const e of walkLocation({
    rootRealPath: loc,
    limits,
    ignore: noIgnore,
    excluded: [],
    ...options,
  }))
    events.push(e);
  return events;
}
const files = (events: WalkEvent[]) =>
  events.flatMap((e) => (e.kind === "file" ? [e.relativePath] : [])).sort();
const skips = (events: WalkEvent[]) =>
  Object.fromEntries(
    events.flatMap((e) => (e.kind === "skip" ? [[e.relativePath, e.reason]] : [])),
  );

/** Wraps the Node file system; `before`/`after` hooks fire around each call, `record` collects what was touched. */
interface Hooks {
  before?: (method: string, args: unknown[], nth: number) => Promise<void> | void;
  after?: (method: string, args: unknown[], nth: number) => Promise<void> | void;
  constants?: BoundaryFs["constants"];
}
function wrap(hooks: Hooks): BoundaryFs & {
  calls: { method: string; args: unknown[] }[];
  openErrors: string[];
  openFlags: number[];
} {
  const counts = new Map<string, number>();
  const calls: { method: string; args: unknown[] }[] = [];
  const openErrors: string[] = [];
  const openFlags: number[] = [];
  const run = async <T>(method: string, args: unknown[], fn: () => Promise<T>): Promise<T> => {
    const nth = (counts.get(method) ?? 0) + 1;
    counts.set(method, nth);
    calls.push({ method, args });
    await hooks.before?.(method, args, nth);
    const result = await fn();
    await hooks.after?.(method, args, nth);
    return result;
  };
  const fs: BoundaryFs = {
    constants: hooks.constants ?? nodeBoundaryFs.constants,
    lstat: (p) => run("lstat", [p], () => nodeBoundaryFs.lstat(p)),
    stat: (p) => run("stat", [p], () => nodeBoundaryFs.stat(p)),
    realpath: (p) => run("realpath", [p], () => nodeBoundaryFs.realpath(p)),
    readdir: (p) => run("readdir", [p], () => nodeBoundaryFs.readdir(p)),
    probe: (p, k) => run("probe", [p, k], () => nodeBoundaryFs.probe(p, k)),
    open: (p, flags) =>
      run("open", [p, flags], async () => {
        openFlags.push(flags);
        try {
          const handle = await nodeBoundaryFs.open(p, flags);
          return {
            stat: () => run("fstat", [p], () => handle.stat()),
            read: (b, o, l, pos) => run("read", [p], () => handle.read(b, o, l, pos)),
            close: () => handle.close(),
          };
        } catch (error) {
          openErrors.push((error as { code?: string }).code ?? "?");
          throw error;
        }
      }),
  };
  return Object.assign(fs, { calls, openErrors, openFlags });
}
const outsideTouched = (calls: { method: string; args: unknown[] }[]) =>
  calls
    .filter((c) => c.method === "open" || c.method === "read")
    .filter((c) => String(c.args[0]).startsWith(out));

const read = (
  relativePath: string,
  fs?: BoundaryFs,
  over: { maxFileBytes?: number; kind?: "folder" | "file"; rootRealPath?: string } = {},
) =>
  readLocationFile({
    rootRealPath: loc,
    relativePath,
    kind: "folder",
    maxFileBytes: 1_000_000,
    excluded: [],
    ...(fs ? { fs } : {}),
    ...over,
  });
const mkfifo = (p: string) => void execFileSync("mkfifo", [p]);

describe("walking a location (I02B-R6)", () => {
  it("lists regular files with `/`-separated relative paths, their size, time and identity", async () => {
    mkdirSync(join(loc, "sub", "deep"), { recursive: true });
    writeFileSync(join(loc, "a.md"), "aaaa");
    writeFileSync(join(loc, "sub", "b.md"), "b");
    writeFileSync(join(loc, "sub", "deep", "c.md"), "c");
    const events = await collect();
    expect(files(events)).toEqual(["a.md", "sub/b.md", "sub/deep/c.md"]);
    const a = events.find((e) => e.kind === "file" && e.relativePath === "a.md");
    expect(a).toMatchObject({ kind: "file", size: 4 });
    if (a?.kind === "file") {
      expect(a.mtimeNs).toMatch(/^\d{16,}$/);
      expect(a.dev).toMatch(/^\d+$/);
      expect(a.ino).toMatch(/^[1-9]\d*$/);
    }
  });

  it("a symlink to a file outside, to a folder outside, to a file inside, and to an ancestor (a loop): all four are skipped as `symlink`, nothing outside is opened, and the walk ends (I02B-C4)", async () => {
    writeFileSync(join(loc, "real.md"), INSIDE);
    symlinkSync(join(out, "secret.txt"), join(loc, "to-outside-file"));
    symlinkSync(out, join(loc, "to-outside-dir"));
    symlinkSync(join(loc, "real.md"), join(loc, "to-inside-file"));
    mkdirSync(join(loc, "d"));
    symlinkSync(loc, join(loc, "d", "loop"));
    const fs = wrap({});
    const events = await collect({ fs });
    expect(skips(events)).toEqual({
      "to-outside-file": "symlink",
      "to-outside-dir": "symlink",
      "to-inside-file": "symlink",
      "d/loop": "symlink",
    });
    expect(files(events)).toEqual(["real.md"]);
    expect(outsideTouched(fs.calls)).toEqual([]);
    expect(fs.calls.some((c) => c.method === "readdir" && String(c.args[0]).startsWith(out))).toBe(
      false,
    );
  });

  it("a directory whose real path is not the root plus its relative path is skipped as `redirected` and not entered", async () => {
    mkdirSync(join(loc, "junction"));
    writeFileSync(join(loc, "junction", "x.md"), INSIDE);
    writeFileSync(join(loc, "ok.md"), INSIDE);
    const real = nodeBoundaryFs;
    const fs: BoundaryFs = {
      ...real,
      // what Windows does for a junction: lstat says directory, the real path is elsewhere
      realpath: async (p) => (p === join(loc, "junction") ? out : real.realpath(p)),
    };
    const events = await collect({ fs });
    expect(skips(events)).toEqual({ junction: "redirected" });
    expect(files(events)).toEqual(["ok.md"]);
  });

  it("applies the depth and relative-path limits: `too-deep`, `path-too-long`", async () => {
    mkdirSync(join(loc, "a", "b", "c"), { recursive: true });
    writeFileSync(join(loc, "a", "b", "c", "deep.md"), "x");
    writeFileSync(join(loc, "a", "ok.md"), "x");
    writeFileSync(join(loc, `${"n".repeat(40)}.md`), "x");
    const events = await collect({ limits: { maxDepth: 3, maxRelativePathChars: 30 } });
    expect(skips(events)).toEqual({
      "a/b/c/deep.md": "too-deep",
      [`${"n".repeat(40)}.md`]: "path-too-long",
    });
    expect(files(events)).toEqual(["a/ok.md"]);
  });

  it("counts names on the ignore list instead of walking them, folders included", async () => {
    mkdirSync(join(loc, "node_modules"));
    writeFileSync(join(loc, "node_modules", "inside.md"), "x");
    writeFileSync(join(loc, ".DS_Store"), "x");
    writeFileSync(join(loc, "keep.md"), "x");
    const events = await collect({ ignore: (n) => n === "node_modules" || n === ".DS_Store" });
    expect(files(events)).toEqual(["keep.md"]);
    expect(
      events
        .filter((e) => e.kind === "ignored")
        .map((e) => e.kind === "ignored" && e.relativePath)
        .sort(),
    ).toEqual([".DS_Store", "node_modules"]);
  });

  it("does not descend into the data directory, however it is spelled: by path, and by identity alone", async () => {
    mkdirSync(join(loc, "data"));
    writeFileSync(join(loc, "data", "secrets.json"), "{}");
    writeFileSync(join(loc, "keep.md"), "x");
    // by path: a different spelling the OS resolves to the stored name (a symlink spelling)
    symlinkSync(join(loc, "data"), join(base, "alias"));
    const byPath = await resolveExcluded(nodeBoundaryFs, [join(base, "alias")]);
    const e1 = await collect({ excluded: byPath });
    expect(files(e1)).toEqual(["keep.md"]);
    expect(e1.some((e) => e.kind === "ignored" && e.relativePath === "data")).toBe(true);
    // by identity alone: the path list is empty, only the (dev, ino) names the folder
    const [full] = await resolveExcluded(nodeBoundaryFs, [join(loc, "data")]);
    const idOnly: ExcludedFolder = { paths: [], id: (full as ExcludedFolder).id };
    expect(idOnly.id).toBeDefined();
    const e2 = await collect({ excluded: [idOnly] });
    expect(files(e2)).toEqual(["keep.md"]);
    // and by path alone: the identity unknown
    const pathOnly: ExcludedFolder = { paths: (full as ExcludedFolder).paths, id: undefined };
    const e3 = await collect({ excluded: [pathOnly] });
    expect(files(e3)).toEqual(["keep.md"]);
  });

  it("a folder that cannot be read is reported, and the other folders are still walked", async () => {
    mkdirSync(join(loc, "locked"));
    writeFileSync(join(loc, "locked", "x.md"), "x");
    writeFileSync(join(loc, "ok.md"), "x");
    chmodSync(join(loc, "locked"), 0o000);
    const events = await collect();
    if (events.some((e) => e.kind === "file" && e.relativePath === "locked/x.md")) return; // this user may read mode 000
    expect(
      events
        .filter((e) => e.kind === "unreadable-dir")
        .map((e) => e.kind === "unreadable-dir" && e.relativePath),
    ).toEqual(["locked"]);
    expect(files(events)).toEqual(["ok.md"]);
  });

  it("a file whose identity reads as 0 is skipped as `identity-unavailable`", async () => {
    writeFileSync(join(loc, "a.md"), "x");
    const real = nodeBoundaryFs;
    const wrapped: BoundaryFs = {
      ...real,
      lstat: async (p) => {
        const s = await real.lstat(p);
        return {
          dev: s.dev,
          ino: p.endsWith("a.md") ? 0n : s.ino,
          size: s.size,
          mtimeNs: s.mtimeNs,
          isFile: () => s.isFile(),
          isDirectory: () => s.isDirectory(),
          isSymbolicLink: () => s.isSymbolicLink(),
        };
      },
    };
    expect(skips(await collect({ fs: wrapped }))).toEqual({ "a.md": "identity-unavailable" });
  });

  it("a FIFO, a socket-like non-regular file in the folder is `not-regular-file`", async () => {
    mkfifo(join(loc, "pipe"));
    writeFileSync(join(loc, "ok.md"), "x");
    const events = await collect();
    expect(skips(events)).toEqual({ pipe: "not-regular-file" });
    expect(files(events)).toEqual(["ok.md"]);
  });
});

describe("reading one file in the order of I02B-R47", () => {
  it("returns the bytes of a regular file with the size, time and identity of the handle that read them", async () => {
    writeFileSync(join(loc, "a.md"), INSIDE);
    const r = await read("a.md");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Buffer.from(r.bytes).toString()).toBe(INSIDE);
      expect(r.size).toBe(INSIDE.length);
      expect(r.mtimeNs).toMatch(/^\d{16,}$/);
      expect(r.ino).toMatch(/^[1-9]\d*$/);
    }
  });

  it("opens with O_NOFOLLOW and O_NONBLOCK where the OS has them, and only then", async () => {
    writeFileSync(join(loc, "a.md"), INSIDE);
    const fs = wrap({});
    await read("a.md", fs);
    expect(fs.openFlags).toHaveLength(1);
    const flags = fs.openFlags[0] as number;
    expect(flags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    expect(flags & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
    // an OS without O_NOFOLLOW (Windows): the flag is not invented
    const win = wrap({ constants: { O_RDONLY: 0, O_NONBLOCK: fsConstants.O_NONBLOCK } });
    await read("a.md", win);
    expect((win.openFlags[0] as number) & fsConstants.O_NOFOLLOW).toBe(0);
    const bare = wrap({ constants: { O_RDONLY: 0 } });
    await read("a.md", bare);
    expect(bare.openFlags[0]).toBe(0);
  });

  it("a symlink at the name is `symlink`; a directory or FIFO is `not-regular-file`; a missing file is `not-readable`", async () => {
    writeFileSync(join(loc, "real.md"), INSIDE);
    symlinkSync(join(out, "secret.txt"), join(loc, "link.md"));
    mkdirSync(join(loc, "dir.md"));
    mkfifo(join(loc, "pipe.md"));
    expect(await read("link.md")).toEqual({ ok: false, reason: "symlink" });
    expect(await read("dir.md")).toEqual({ ok: false, reason: "not-regular-file" });
    expect(await read("pipe.md")).toEqual({ ok: false, reason: "not-regular-file" });
    expect(await read("gone.md")).toEqual({ ok: false, reason: "not-readable" });
  });

  it("a file over maxFileBytes is `too-large`, by the handle's size and by what is really read", async () => {
    writeFileSync(join(loc, "big.md"), "x".repeat(2000));
    const sized = wrap({});
    expect(await read("big.md", sized, { maxFileBytes: 1000 })).toEqual({
      ok: false,
      reason: "too-large",
    });
    // refused on the handle's size alone: not one byte was read
    expect(sized.calls.filter((c) => c.method === "read")).toEqual([]);
    // a file that grows after the size was read: the read itself stops at the cap
    const growing = wrap({
      after: async (method, args) => {
        if (method === "fstat") writeFileSync(String(args[0]), "y".repeat(5000));
      },
    });
    writeFileSync(join(loc, "grow.md"), "z");
    expect(await read("grow.md", growing, { maxFileBytes: 1000 })).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("a file location is read by its own real path", async () => {
    writeFileSync(join(loc, "one.md"), INSIDE);
    const r = await readLocationFile({
      excluded: [],
      rootRealPath: join(loc, "one.md"),
      relativePath: "",
      kind: "file",
      maxFileBytes: 1000,
    });
    expect(r.ok && Buffer.from(r.bytes).toString()).toBe(INSIDE);
  });

  it("a file the user may not read is `not-readable`", async () => {
    writeFileSync(join(loc, "nope.md"), INSIDE);
    chmodSync(join(loc, "nope.md"), 0o000);
    const r = await read("nope.md");
    if (r.ok) return; // this user may read mode 000
    expect(r).toEqual({ ok: false, reason: "not-readable" });
  });

  // --- I02B-C4: swaps put exactly between the steps --------------------------------------------
  it("ⓐ the folder is swapped for a symlink to outside after it was checked and left that way: `redirected`, the bytes read through it are discarded (step 6)", async () => {
    mkdirSync(join(loc, "dir"));
    writeFileSync(join(loc, "dir", "a.md"), INSIDE);
    mkdirSync(join(out, "dir-content"));
    writeFileSync(join(out, "dir-content", "a.md"), OUTSIDE);
    let swapped = false;
    const fs = wrap({
      before: (method, args) => {
        if (method === "lstat" && String(args[0]).endsWith("a.md") && !swapped) {
          swapped = true;
          renameSync(join(loc, "dir"), join(loc, "dir-away"));
          symlinkSync(join(out, "dir-content"), join(loc, "dir"));
        }
      },
    });
    const r = await read("dir/a.md", fs);
    expect(swapped).toBe(true);
    expect(r).toEqual({ ok: false, reason: "redirected" });
    // the bytes were reached through the swapped folder, and none of them left the module
    expect(JSON.stringify(r)).not.toContain(OUTSIDE);
  });

  it("ⓑ the name is swapped for a symlink to an outside file between lstat and open: O_NOFOLLOW refuses it (ELOOP), nothing outside is read", async () => {
    writeFileSync(join(loc, "a.md"), INSIDE);
    const fs = wrap({
      after: (method, args) => {
        if (method === "lstat" && String(args[0]).endsWith("a.md")) {
          unlinkSync(join(loc, "a.md"));
          symlinkSync(join(out, "secret.txt"), join(loc, "a.md"));
        }
      },
    });
    const r = await read("a.md", fs);
    expect(r).toEqual({ ok: false, reason: "redirected" });
    expect(fs.openErrors).toEqual(["ELOOP"]);
    expect(outsideTouched(fs.calls).filter((c) => c.method === "read")).toEqual([]);
  });

  it("ⓑ without O_NOFOLLOW (the Windows shape) the handle's identity comparison (step 4) catches the same swap before any byte is read", async () => {
    writeFileSync(join(loc, "a.md"), INSIDE);
    const fs = wrap({
      constants: { O_RDONLY: 0, O_NONBLOCK: fsConstants.O_NONBLOCK },
      after: (method, args) => {
        if (method === "lstat" && String(args[0]).endsWith("a.md")) {
          unlinkSync(join(loc, "a.md"));
          symlinkSync(join(out, "secret.txt"), join(loc, "a.md"));
        }
      },
    });
    const r = await read("a.md", fs);
    expect(r).toEqual({ ok: false, reason: "redirected" });
    expect(fs.openErrors).toEqual([]); // the open succeeded: it was step 4 that refused
    expect(fs.calls.filter((c) => c.method === "read")).toEqual([]); // not a byte was read
  });

  it("ⓑ another regular file renamed over the name between lstat and open: `redirected` (a different identity)", async () => {
    writeFileSync(join(loc, "a.md"), INSIDE);
    writeFileSync(join(loc, "b.md"), "REPLACEMENT");
    const fs = wrap({
      after: (method, args) => {
        if (method === "lstat" && String(args[0]).endsWith("a.md"))
          renameSync(join(loc, "b.md"), join(loc, "a.md"));
      },
    });
    expect(await read("a.md", fs)).toEqual({ ok: false, reason: "redirected" });
  });

  it("ⓒ the folder is swapped after the bytes were read and before the re-measure: `redirected`, the bytes are discarded (step 6)", async () => {
    mkdirSync(join(loc, "dir"));
    writeFileSync(join(loc, "dir", "a.md"), INSIDE);
    mkdirSync(join(out, "dir-content"));
    writeFileSync(join(out, "dir-content", "a.md"), OUTSIDE);
    let reads = 0;
    const fs = wrap({
      after: (method) => {
        if (method === "read") reads++;
      },
      before: (method, args, nth) => {
        // the second realpath of the folder is the re-measure of step 6
        if (method === "realpath" && String(args[0]) === join(loc, "dir") && nth === 2) {
          renameSync(join(loc, "dir"), join(loc, "dir-away"));
          symlinkSync(join(out, "dir-content"), join(loc, "dir"));
        }
      },
    });
    const r = await read("dir/a.md", fs);
    expect(reads).toBeGreaterThan(0); // the bytes WERE read
    expect(r).toEqual({ ok: false, reason: "redirected" });
  });

  it("ⓒ the folder is replaced by another folder of the same name (same real path, other identity) before the re-measure: `redirected`, the identity half of step 6", async () => {
    mkdirSync(join(loc, "dir"));
    writeFileSync(join(loc, "dir", "a.md"), INSIDE);
    const fs = wrap({
      before: (method, args, nth) => {
        if (method === "realpath" && String(args[0]) === join(loc, "dir") && nth === 2) {
          renameSync(join(loc, "dir"), join(loc, "dir-away"));
          mkdirSync(join(loc, "dir"));
          writeFileSync(join(loc, "dir", "a.md"), "LOOKALIKE");
        }
      },
    });
    expect(await read("dir/a.md", fs)).toEqual({ ok: false, reason: "redirected" });
  });

  it("a folder whose identity reads as 0 is `identity-unavailable` before the name is looked at", async () => {
    mkdirSync(join(loc, "dir"));
    writeFileSync(join(loc, "dir", "a.md"), INSIDE);
    const real = nodeBoundaryFs;
    const fs: BoundaryFs = {
      ...real,
      stat: async (p) => {
        const s = await real.stat(p);
        return {
          dev: s.dev,
          ino: p === join(loc, "dir") ? 0n : s.ino,
          size: s.size,
          mtimeNs: s.mtimeNs,
          isFile: () => s.isFile(),
          isDirectory: () => s.isDirectory(),
          isSymbolicLink: () => s.isSymbolicLink(),
        };
      },
    };
    expect(await read("dir/a.md", fs)).toEqual({ ok: false, reason: "identity-unavailable" });
  });

  it("ⓒ the OS reports another real path for the folder at the re-measure while its identity is unchanged (an identity that cannot be trusted): `redirected`, the path half of step 6", async () => {
    mkdirSync(join(loc, "dir"));
    writeFileSync(join(loc, "dir", "a.md"), INSIDE);
    const real = nodeBoundaryFs;
    let calls = 0;
    const fs: BoundaryFs = {
      ...real,
      realpath: async (p) => (p === join(loc, "dir") && ++calls === 2 ? out : real.realpath(p)),
    };
    expect(await read("dir/a.md", fs)).toEqual({ ok: false, reason: "redirected" });
  });

  it("ⓓ the name is swapped for a FIFO between lstat and open: `not-regular-file` and no stall (O_NONBLOCK)", async () => {
    writeFileSync(join(loc, "a.md"), INSIDE);
    writeFileSync(join(loc, "ok.md"), INSIDE);
    const fs = wrap({
      after: (method, args) => {
        if (method === "lstat" && String(args[0]).endsWith("a.md")) {
          unlinkSync(join(loc, "a.md"));
          mkfifo(join(loc, "a.md"));
        }
      },
    });
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      read("a.md", fs),
      new Promise<"stalled">((resolve) => {
        timer = setTimeout(() => resolve("stalled"), 3000);
      }),
    ]);
    clearTimeout(timer);
    if (outcome === "stalled") {
      // let the pending open return so the process is not left with a stuck thread
      try {
        closeSync(openSync(join(loc, "a.md"), fsConstants.O_RDWR | fsConstants.O_NONBLOCK));
      } catch {
        /* nothing more to do */
      }
    }
    expect(outcome).toEqual({ ok: false, reason: "not-regular-file" });
    expect(Date.now() - started).toBeLessThan(3000);
    // the rest of the folder is unaffected
    expect((await read("ok.md")).ok).toBe(true);
  });

  it("an identity of 0 at the name is `identity-unavailable`", async () => {
    writeFileSync(join(loc, "a.md"), INSIDE);
    const real = nodeBoundaryFs;
    const fs: BoundaryFs = {
      ...real,
      lstat: async (p) => {
        const s = await real.lstat(p);
        return {
          dev: s.dev,
          ino: p.endsWith("a.md") ? 0n : s.ino,
          size: s.size,
          mtimeNs: s.mtimeNs,
          isFile: () => s.isFile(),
          isDirectory: () => s.isDirectory(),
          isSymbolicLink: () => s.isSymbolicLink(),
        };
      },
    };
    expect(await read("a.md", fs)).toEqual({ ok: false, reason: "identity-unavailable" });
  });

  it("the folder is not the one the relative path names (a redirect at the first step) is `redirected` before the name is looked at", async () => {
    mkdirSync(join(loc, "dir"));
    writeFileSync(join(loc, "dir", "a.md"), INSIDE);
    const fs = wrap({});
    const spoof: BoundaryFs = {
      ...fs,
      realpath: async (p) => (p === join(loc, "dir") ? out : fs.realpath(p)),
    };
    expect(await read("dir/a.md", spoof)).toEqual({ ok: false, reason: "redirected" });
    expect(fs.calls.filter((c) => c.method === "lstat" || c.method === "open")).toEqual([]);
  });

  it("a hard link is an ordinary file of the folder (I02B-R6: the remaining risk 3)", async () => {
    writeFileSync(join(out, "linked.txt"), "HARD");
    execFileSync("ln", [join(out, "linked.txt"), join(loc, "hard.md")]);
    const r = await read("hard.md");
    expect(r.ok && Buffer.from(r.bytes).toString()).toBe("HARD");
  });
});
