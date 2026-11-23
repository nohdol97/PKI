// I02B-T02b review round 1 (path half): the exclusion is required and also guards reads; the walk
// re-checks a folder after listing it; a read may be pinned to the walk's identity.
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
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
  type StatInfo,
  type WalkEvent,
} from "./local-path.ts";

/** The identity the walk would have seen: the file's own, measured on the real disk. */
const seenId = (path: string): { dev: string; ino: string } => {
  const s = lstatSync(path, { bigint: true });
  return { dev: s.dev.toString(), ino: s.ino.toString() };
};
let base: string;
let loc: string;
let out: string;
let data: string;
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "pki-review-")));
  loc = join(base, "loc");
  out = join(base, "out");
  data = join(loc, "PkiData");
  mkdirSync(data, { recursive: true });
  mkdirSync(out);
  writeFileSync(join(data, "secrets.json"), "DATA-SECRET");
  writeFileSync(join(loc, "a.txt"), "a");
  writeFileSync(join(out, "o.txt"), "OUT");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const limits = { maxDepth: 32, maxRelativePathChars: 1024 };
async function walk(fs: BoundaryFs, excluded = [] as Awaited<ReturnType<typeof resolveExcluded>>) {
  const events: WalkEvent[] = [];
  for await (const e of walkLocation({
    fs,
    rootRealPath: loc,
    limits,
    ignore: () => false,
    excluded,
  }))
    events.push(e);
  return events;
}
const files = (events: WalkEvent[]) =>
  events.flatMap((e) => (e.kind === "file" ? [e.relativePath] : [])).sort();
const lie = (s: StatInfo, over: Partial<{ dev: bigint; ino: bigint }>): StatInfo => ({
  dev: over.dev ?? s.dev,
  ino: over.ino ?? s.ino,
  size: s.size,
  mtimeNs: s.mtimeNs,
  isFile: () => s.isFile(),
  isDirectory: () => s.isDirectory(),
  isSymbolicLink: () => s.isSymbolicLink(),
});

describe("the exclusion is required (P-F1)", () => {
  it("omitting `excluded` is a type error and, at run time, a refusal, never a silent walk of the data directory", async () => {
    const events: WalkEvent[] = [];
    await expect(
      (async () => {
        // @ts-expect-error `excluded` is required: an empty list must be written out
        for await (const e of walkLocation({ rootRealPath: loc, limits, ignore: () => false }))
          events.push(e);
      })(),
    ).rejects.toThrow(TypeError);
    expect(files(events)).toEqual([]);
    await expect(
      // @ts-expect-error `excluded` is required for a read as well
      readLocationFile({
        rootRealPath: loc,
        relativePath: "a.txt",
        kind: "folder",
        maxFileBytes: 100,
        expectedId: seenId(join(loc, "a.txt")),
      }),
    ).rejects.toThrow(TypeError);
  });

  it("a walk that lists the exclusion skips the data directory; one with an empty list shows what is at stake", async () => {
    expect(files(await walk(nodeBoundaryFs))).toContain("PkiData/secrets.json");
    const excluded = await resolveExcluded(nodeBoundaryFs, [data]);
    expect(files(await walk(nodeBoundaryFs, excluded))).toEqual(["a.txt"]);
  });

  it("a read of a file under an excluded folder is refused, by path and by identity, with no byte returned", async () => {
    const excluded = await resolveExcluded(nodeBoundaryFs, [data]);
    const attempt = (excl: typeof excluded) =>
      readLocationFile({
        rootRealPath: loc,
        relativePath: "PkiData/secrets.json",
        kind: "folder",
        maxFileBytes: 100,
        excluded: excl,
        expectedId: seenId(join(data, "secrets.json")),
      });
    expect(await attempt(excluded)).toEqual({ ok: false, reason: "excluded" });
    // by identity alone (the path list is empty)
    expect(await attempt([{ paths: [], id: excluded[0]?.id }])).toEqual({
      ok: false,
      reason: "excluded",
    });
    // by path alone (the identity unknown)
    expect(await attempt([{ paths: excluded[0]?.paths ?? [], id: undefined }])).toEqual({
      ok: false,
      reason: "excluded",
    });
    // a file nobody excluded still reads; a deeper file under the excluded folder is refused too
    mkdirSync(join(data, "deep"));
    writeFileSync(join(data, "deep", "x.json"), "X");
    expect(
      await readLocationFile({
        rootRealPath: loc,
        relativePath: "PkiData/deep/x.json",
        kind: "folder",
        maxFileBytes: 100,
        excluded,
        expectedId: seenId(join(data, "deep", "x.json")),
      }),
    ).toEqual({ ok: false, reason: "excluded" });
    const ok = await readLocationFile({
      rootRealPath: loc,
      relativePath: "a.txt",
      kind: "folder",
      maxFileBytes: 100,
      excluded,
      expectedId: seenId(join(loc, "a.txt")),
    });
    expect(ok.ok).toBe(true);
  });

  it("an unreadable identity chain for a read under an identity-only exclusion is refused (fail closed)", async () => {
    const excluded = await resolveExcluded(nodeBoundaryFs, [data]);
    const fs: BoundaryFs = {
      ...nodeBoundaryFs,
      stat: async (p) => {
        if (p === base) throw Object.assign(new Error("EIO"), { code: "EIO" });
        return nodeBoundaryFs.stat(p);
      },
    };
    const r = await readLocationFile({
      fs,
      rootRealPath: loc,
      relativePath: "a.txt",
      kind: "folder",
      maxFileBytes: 100,
      excluded: [{ paths: [], id: excluded[0]?.id }],
      expectedId: seenId(join(loc, "a.txt")),
    });
    expect(r).toEqual({ ok: false, reason: "excluded" });
  });
});

describe("the walk re-checks a folder after listing it (P-F2)", () => {
  it("a folder swapped for a symlink to elsewhere while it is listed yields `redirected` and none of the outside names", async () => {
    mkdirSync(join(loc, "sub"));
    writeFileSync(join(loc, "sub", "inside.txt"), "i");
    const fs: BoundaryFs = {
      ...nodeBoundaryFs,
      readdir: async (p) => {
        const names = await nodeBoundaryFs.readdir(p);
        if (p === join(loc, "sub")) {
          renameSync(join(loc, "sub"), join(loc, "sub-away"));
          symlinkSync(out, join(loc, "sub"));
        }
        return names;
      },
    };
    const events = await walk(fs);
    expect(events.find((e) => e.kind === "skip" && e.relativePath === "sub")).toMatchObject({
      reason: "redirected",
    });
    expect(files(events).filter((f) => f.startsWith("sub/"))).toEqual([]);
  });

  it("the same swap for a symlink to the data directory lists none of its files", async () => {
    mkdirSync(join(loc, "normal"));
    const fs: BoundaryFs = {
      ...nodeBoundaryFs,
      readdir: async (p) => {
        if (p === join(loc, "normal")) {
          renameSync(join(loc, "normal"), join(loc, "normal-away"));
          symlinkSync(data, join(loc, "normal"));
          return nodeBoundaryFs.readdir(join(loc, "normal"));
        }
        return nodeBoundaryFs.readdir(p);
      },
    };
    const events = await walk(fs, await resolveExcluded(nodeBoundaryFs, [data]));
    expect(files(events).some((f) => f.endsWith("secrets.json"))).toBe(false);
  });

  it("a folder replaced by another of the same name (same real path, other identity) while listed is `redirected`", async () => {
    mkdirSync(join(loc, "sub"));
    writeFileSync(join(loc, "sub", "inside.txt"), "i");
    let swapped = false;
    const fs: BoundaryFs = {
      ...nodeBoundaryFs,
      readdir: async (p) => {
        const names = await nodeBoundaryFs.readdir(p);
        if (p === join(loc, "sub") && !swapped) {
          swapped = true;
          renameSync(join(loc, "sub"), join(loc, "sub-away"));
          mkdirSync(join(loc, "sub"));
        }
        return names;
      },
    };
    const events = await walk(fs);
    expect(events.find((e) => e.kind === "skip" && e.relativePath === "sub")).toMatchObject({
      reason: "redirected",
    });
  });
});

describe("the walk's re-check, each half alone (P-F2)", () => {
  it("the OS reporting another real path after listing, with the same identity, is `redirected` (the path half)", async () => {
    mkdirSync(join(loc, "sub"));
    writeFileSync(join(loc, "sub", "inside.txt"), "i");
    const alias = join(loc, "sub-alias");
    let calls = 0;
    const fs: BoundaryFs = {
      ...nodeBoundaryFs,
      realpath: async (p) =>
        p === join(loc, "sub") && ++calls === 2 ? alias : nodeBoundaryFs.realpath(p),
      stat: async (p) => nodeBoundaryFs.stat(p === alias ? join(loc, "sub") : p),
    };
    const events = await walk(fs);
    expect(events.find((e) => e.kind === "skip" && e.relativePath === "sub")).toMatchObject({
      reason: "redirected",
    });
    expect(files(events)).not.toContain("sub/inside.txt");
  });

  it("a different identity after listing with the same real path is `redirected` (the identity half)", async () => {
    mkdirSync(join(loc, "sub"));
    writeFileSync(join(loc, "sub", "inside.txt"), "i");
    let calls = 0;
    const fs: BoundaryFs = {
      ...nodeBoundaryFs,
      stat: async (p) => {
        const s = await nodeBoundaryFs.stat(p);
        return p === join(loc, "sub") && ++calls === 2 ? lie(s, { ino: s.ino + 1n }) : s;
      },
    };
    const events = await walk(fs);
    expect(events.find((e) => e.kind === "skip" && e.relativePath === "sub")).toMatchObject({
      reason: "redirected",
    });
  });

  it("a folder that cannot be measured after listing is reported unreadable, not listed", async () => {
    mkdirSync(join(loc, "sub"));
    writeFileSync(join(loc, "sub", "inside.txt"), "i");
    let calls = 0;
    const fs: BoundaryFs = {
      ...nodeBoundaryFs,
      realpath: async (p) => {
        if (p === join(loc, "sub") && ++calls === 2)
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        return nodeBoundaryFs.realpath(p);
      },
    };
    const events = await walk(fs);
    expect(events.some((e) => e.kind === "unreadable-dir" && e.relativePath === "sub")).toBe(true);
    expect(files(events)).not.toContain("sub/inside.txt");
  });
});

describe("a read can be pinned to the identity the walk saw (P-W1)", () => {
  it("a different (dev, ino) than the walk's is refused as `redirected`; the same one reads", async () => {
    const events = await walk(nodeBoundaryFs);
    const a = events.find((e) => e.kind === "file" && e.relativePath === "a.txt");
    if (a?.kind !== "file") throw new Error("setup");
    const base_ = {
      rootRealPath: loc,
      relativePath: "a.txt",
      kind: "folder" as const,
      maxFileBytes: 100,
      excluded: [],
    };
    expect((await readLocationFile({ ...base_, expectedId: { dev: a.dev, ino: a.ino } })).ok).toBe(
      true,
    );
    expect(
      await readLocationFile({ ...base_, expectedId: { dev: a.dev, ino: `${a.ino}1` } }),
    ).toEqual({ ok: false, reason: "redirected" });
  });
});

describe("dev 0 in the walk and the read (P-F4)", () => {
  it("a file or folder whose dev reads as 0 is `identity-unavailable`", async () => {
    const fs: BoundaryFs = {
      ...nodeBoundaryFs,
      lstat: async (p) =>
        p.endsWith("a.txt")
          ? lie(await nodeBoundaryFs.lstat(p), { dev: 0n })
          : nodeBoundaryFs.lstat(p),
    };
    const events = await walk(fs);
    expect(events.find((e) => e.kind === "skip" && e.relativePath === "a.txt")).toMatchObject({
      reason: "identity-unavailable",
    });
    expect(
      await readLocationFile({
        fs,
        rootRealPath: loc,
        relativePath: "a.txt",
        kind: "folder",
        maxFileBytes: 100,
        excluded: [],
        expectedId: { dev: "0", ino: "0" },
      }),
    ).toEqual({ ok: false, reason: "identity-unavailable" });
  });
});
