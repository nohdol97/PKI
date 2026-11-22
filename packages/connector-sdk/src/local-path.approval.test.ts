// I02B-T02 (I02B-R5, R6, R48; I02B-C3 at the check function, I02B-C38): the approval check and its
// closed list of rejection codes. Real temporary folders where the OS can make the case; a file
// system stub where it cannot (an identity of 0, two spellings of one folder, a Windows root).
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPROVAL_REJECTION_CODES,
  checkApproval,
  NETWORK_LOCATION_NOTE,
  nodeBoundaryFs,
  type ApprovalContext,
  type ApprovalKind,
  type ApprovalRejection,
  type BoundaryFs,
  type StatInfo,
} from "./local-path.ts";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "pki-approve-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const isDocument = (name: string) => /\.(md|txt|docx|pdf)$/i.test(name);
const ctx = (over: Partial<ApprovalContext> = {}): ApprovalContext => ({
  forbidden: [],
  locations: [],
  isDocumentFile: isDocument,
  ...over,
});
const reject = async (kind: ApprovalKind, path: string, c: ApprovalContext = ctx()) => {
  const r = await checkApproval({ kind, path }, c);
  if (r.ok) throw new Error(`approved: ${path}`);
  return r;
};

// --- a file system stub: path string -> what the OS would say ---------------------------------
interface Node {
  real?: string; // what realpath returns (default: the path itself)
  id?: [bigint, bigint]; // dev, ino (default: a fresh non-zero identity)
  kind?: "dir" | "file";
  unreadable?: boolean;
  statThrows?: boolean; // the OS cannot say (an unplugged or failing volume)
}
function stubFs(nodes: Record<string, Node>): BoundaryFs {
  let next = 1000n;
  const ids = new Map<string, [bigint, bigint]>();
  const nodeOf = (p: string): Node => {
    const n = nodes[p];
    if (!n) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return n;
  };
  const stat = (p: string): StatInfo => {
    const n = nodeOf(p);
    if (n.statThrows) throw Object.assign(new Error("EIO"), { code: "EIO" });
    const id = n.id ?? ids.get(p) ?? (ids.set(p, [1n, next++]), ids.get(p) as [bigint, bigint]);
    const kind = n.kind ?? "dir";
    return {
      dev: id[0],
      ino: id[1],
      size: 0n,
      mtimeNs: 0n,
      isFile: () => kind === "file",
      isDirectory: () => kind === "dir",
      isSymbolicLink: () => false,
    };
  };
  return {
    constants: { O_RDONLY: 0 },
    lstat: async (p) => stat(p),
    stat: async (p) => stat(realOf(p)),
    realpath: async (p) => realOf(p),
    readdir: async () => [],
    open: async () => {
      throw new Error("the stub opens nothing");
    },
    probe: async (p) => {
      if (nodeOf(realOf(p)).unreadable)
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    },
  };
  function realOf(p: string): string {
    nodeOf(p);
    return nodes[p]?.real ?? p;
  }
}

describe("a path that passes returns the real path and the identity (I02B-R5)", () => {
  it("a folder; a symlink to it is approved as the folder it points at (I02B-C3)", async () => {
    mkdirSync(join(root, "docs"));
    symlinkSync(join(root, "docs"), join(root, "link"));
    const direct = await checkApproval({ kind: "folder", path: join(root, "docs") }, ctx());
    const viaLink = await checkApproval({ kind: "folder", path: join(root, "link") }, ctx());
    expect(direct).toMatchObject({
      ok: true,
      realPath: join(root, "docs"),
      displayPath: join(root, "docs"),
    });
    expect(viaLink).toMatchObject({
      ok: true,
      realPath: join(root, "docs"),
      displayPath: join(root, "link"),
    });
    if (direct.ok) {
      expect(direct.dev).toMatch(/^\d+$/);
      expect(direct.ino).toMatch(/^[1-9]\d*$/);
      expect(viaLink.ok && viaLink.ino).toBe(direct.ino);
    }
  });

  it("a document file and a .jsonl file", async () => {
    writeFileSync(join(root, "a.md"), "x");
    writeFileSync(join(root, "lines.JSONL"), "{}");
    expect((await checkApproval({ kind: "file", path: join(root, "a.md") }, ctx())).ok).toBe(true);
    expect(
      (await checkApproval({ kind: "jsonl-file", path: join(root, "lines.JSONL") }, ctx())).ok,
    ).toBe(true);
  });

  it("a trailing separator does not change the answer", async () => {
    mkdirSync(join(root, "docs"));
    const r = await checkApproval({ kind: "folder", path: `${join(root, "docs")}/` }, ctx());
    expect(r).toMatchObject({ ok: true, realPath: join(root, "docs") });
  });
});

describe("one case per rejection code (I02B-C3)", () => {
  const cases: Record<ApprovalRejection, () => Promise<ApprovalRejection>> = {
    "not-absolute": async () => (await reject("folder", "relative/docs")).code,
    "unsupported-path-form": async () =>
      (await reject("folder", "C:foo", ctx({ rules: "win32" }))).code,
    "not-found": async () => (await reject("folder", join(root, "missing"))).code,
    "not-readable": async () => {
      mkdirSync(join(root, "locked"));
      const fs = stubFs({ [join(root, "locked")]: { unreadable: true } });
      return (await reject("folder", join(root, "locked"), ctx({ fs }))).code;
    },
    "wrong-type": async () => {
      writeFileSync(join(root, "a.md"), "x");
      return (await reject("folder", join(root, "a.md"))).code;
    },
    "identity-unavailable": async () => {
      const fs = stubFs({ "/vol/zero": { id: [1n, 0n] } });
      return (await reject("folder", "/vol/zero", ctx({ fs, rules: "posix" }))).code;
    },
    "filesystem-root": async () => (await reject("folder", "/", ctx({ rules: "posix" }))).code,
    "inside-data-directory": async () => {
      mkdirSync(join(root, "data"));
      return (await reject("folder", join(root, "data"), ctx({ forbidden: [join(root, "data")] })))
        .code;
    },
    "overlaps-location": async () => {
      mkdirSync(join(root, "docs"));
      const a = await checkApproval({ kind: "folder", path: join(root, "docs") }, ctx());
      if (!a.ok) throw new Error("setup");
      const loc = { id: "L".repeat(22), realPath: a.realPath, rootDev: a.dev, rootIno: a.ino };
      return (await reject("folder", join(root, "docs"), ctx({ locations: [loc] }))).code;
    },
    "network-location": async () => {
      const r = await reject("folder", String.raw`\\server\share\docs`, ctx({ rules: "win32" }));
      expect(r.message).toContain("미구현, 배포처 후속");
      expect(r.message).toContain(NETWORK_LOCATION_NOTE);
      return r.code;
    },
    "unsupported-format": async () => {
      writeFileSync(join(root, "a.hwp"), "x");
      return (await reject("file", join(root, "a.hwp"))).code;
    },
  };

  it("the code list and the case list are the same set", () => {
    expect(Object.keys(cases).sort()).toEqual([...APPROVAL_REJECTION_CODES].sort());
  });

  for (const code of APPROVAL_REJECTION_CODES) {
    it(`${code}`, async () => {
      expect(await cases[code]()).toBe(code);
    });
  }

  it("not-readable on a real folder the user may not open (skipped when the OS lets this user in anyway)", async () => {
    mkdirSync(join(root, "locked"));
    chmodSync(join(root, "locked"), 0o000);
    try {
      const r = await checkApproval({ kind: "folder", path: join(root, "locked") }, ctx());
      if (r.ok) return; // running as a user for whom mode 000 does not block
      expect(r.code).toBe("not-readable");
    } finally {
      chmodSync(join(root, "locked"), 0o700);
    }
  });

  it("wrong-type in every direction: a file for a folder, a folder for file and jsonl-file", async () => {
    mkdirSync(join(root, "d.md"));
    writeFileSync(join(root, "f.txt"), "x");
    expect((await reject("folder", join(root, "f.txt"))).code).toBe("wrong-type");
    expect((await reject("file", join(root, "d.md"))).code).toBe("wrong-type");
    expect((await reject("jsonl-file", join(root, "d.md"))).code).toBe("wrong-type");
  });

  it("both kinds of unsupported-format: a non-document file, and a jsonl-file without the extension", async () => {
    writeFileSync(join(root, "lines.txt"), "x");
    writeFileSync(join(root, "a.pptx"), "x");
    expect((await reject("jsonl-file", join(root, "lines.txt"))).code).toBe("unsupported-format");
    expect((await reject("file", join(root, "a.pptx"))).code).toBe("unsupported-format");
  });

  it("overlaps-location: the same place, a place inside it, a place that contains it", async () => {
    mkdirSync(join(root, "outer", "inner"), { recursive: true });
    const approve = async (p: string) => {
      const a = await checkApproval({ kind: "folder", path: p }, ctx());
      if (!a.ok) throw new Error("setup");
      return { id: "L".repeat(22), realPath: a.realPath, rootDev: a.dev, rootIno: a.ino };
    };
    const outer = await approve(join(root, "outer"));
    const inner = await approve(join(root, "outer", "inner"));
    expect((await reject("folder", join(root, "outer"), ctx({ locations: [outer] }))).code).toBe(
      "overlaps-location",
    );
    expect(
      (await reject("folder", join(root, "outer", "inner"), ctx({ locations: [outer] }))).code,
    ).toBe("overlaps-location");
    expect((await reject("folder", join(root, "outer"), ctx({ locations: [inner] }))).code).toBe(
      "overlaps-location",
    );
    // a sibling whose name only begins the same way is not inside (parts, not text)
    mkdirSync(join(root, "outer2"));
    expect(
      (
        await checkApproval(
          { kind: "folder", path: join(root, "outer2") },
          ctx({ locations: [outer] }),
        )
      ).ok,
    ).toBe(true);
  });

  it("a reconnect leaves the location itself out of the overlap check", async () => {
    mkdirSync(join(root, "docs"));
    const a = await checkApproval({ kind: "folder", path: join(root, "docs") }, ctx());
    if (!a.ok) throw new Error("setup");
    const loc = { id: "L".repeat(22), realPath: a.realPath, rootDev: a.dev, rootIno: a.ino };
    const again = await checkApproval(
      { kind: "folder", path: join(root, "docs") },
      ctx({ locations: [loc], ignoreLocationId: loc.id }),
    );
    expect(again.ok).toBe(true);
  });

  it("a data directory is rejected, its subfolder too; a folder that CONTAINS it is approved (it is skipped when walked)", async () => {
    mkdirSync(join(root, "home", "data", "sub"), { recursive: true });
    const forbidden = [join(root, "home", "data")];
    expect((await reject("folder", join(root, "home", "data"), ctx({ forbidden }))).code).toBe(
      "inside-data-directory",
    );
    expect(
      (await reject("folder", join(root, "home", "data", "sub"), ctx({ forbidden }))).code,
    ).toBe("inside-data-directory");
    expect(
      (await checkApproval({ kind: "folder", path: join(root, "home") }, ctx({ forbidden }))).ok,
    ).toBe(true);
  });

  it("a file inside the data directory is rejected as well", async () => {
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data", "secrets.md"), "x");
    expect(
      (
        await reject(
          "file",
          join(root, "data", "secrets.md"),
          ctx({ forbidden: [join(root, "data")] }),
        )
      ).code,
    ).toBe("inside-data-directory");
  });

  it("when a request hits several reasons the first row of the table wins", async () => {
    // UNC wins over everything the file system would say (it is decided by the shape alone)
    expect(
      (await reject("file", String.raw`\\?\UNC\srv\share\a.hwp`, ctx({ rules: "win32" }))).code,
    ).toBe("network-location");
    // wrong-type before unsupported-format
    mkdirSync(join(root, "x.hwp"));
    expect((await reject("file", join(root, "x.hwp"))).code).toBe("wrong-type");
    // identity-unavailable before filesystem-root
    const fs = stubFs({ "/": { id: [1n, 0n] } });
    expect((await reject("folder", "/", ctx({ fs, rules: "posix" }))).code).toBe(
      "identity-unavailable",
    );
    // not-absolute before unsupported-path-form
    expect(
      (await reject("folder", String.raw`C:\a\..\PROGRA~1`, ctx({ rules: "win32" }))).code,
    ).toBe("not-absolute");
  });

  it("a Windows drive root is filesystem-root (the shape is decided on the Windows rules, the OS asked through the stub)", async () => {
    const fs = stubFs({ "C:\\": {} });
    expect((await reject("folder", "C:\\", ctx({ fs, rules: "win32" }))).code).toBe(
      "filesystem-root",
    );
  });
});

// --- I02B-C38: two ways to see the same folder, each kept alive separately ----------------------
describe("path and identity are two routes; either one saying 'inside' is enough (I02B-C38)", () => {
  const DATA = "/vol/Data Dir";
  const USER = "/vol/Shell User";
  const DOCS = "/vol/Docs";
  const base = (): Record<string, Node> => ({
    "/": { id: [1n, 2n] },
    "/vol": { id: [1n, 3n] },
    [DATA]: { id: [1n, 10n] },
    [`${DATA}/sub`]: { id: [1n, 11n] },
    [USER]: { id: [1n, 12n] },
    [`${USER}/sub`]: { id: [1n, 13n] },
    [DOCS]: { id: [1n, 20n] },
  });
  const location = { id: "L".repeat(22), realPath: DOCS, rootDev: "1", rootIno: "20" };
  const forbidden = [DATA, USER];

  const expectAll = async (spell: (p: string) => string, nodes: Record<string, Node>) => {
    const fs = stubFs(nodes);
    const c = ctx({ fs, rules: "posix", forbidden, locations: [location] });
    expect((await reject("folder", spell(DATA), c)).code).toBe("inside-data-directory"); // 1
    expect((await reject("folder", spell(`${DATA}/sub`), c)).code).toBe("inside-data-directory"); // 2
    expect((await reject("folder", spell(USER), c)).code).toBe("inside-data-directory"); // 3
    expect((await reject("folder", spell(DOCS), c)).code).toBe("overlaps-location"); // 4
  };

  it("identity route alone: a short-name style spelling the OS did not expand, same identity (path route cannot see it)", async () => {
    const nodes = base();
    const spelled: Record<string, string> = {
      [DATA]: "/vol/DATADI~1",
      [`${DATA}/sub`]: "/vol/DATADI~1/sub",
      [USER]: "/vol/SHELLU~1",
      [DOCS]: "/vol/DOCS~1",
    };
    nodes["/vol/DATADI~1"] = { id: [1n, 10n] };
    nodes["/vol/DATADI~1/sub"] = { id: [1n, 11n] };
    nodes["/vol/SHELLU~1"] = { id: [1n, 12n] };
    nodes["/vol/DOCS~1"] = { id: [1n, 20n] };
    await expectAll((p) => spelled[p] ?? p, nodes);
  });

  it("identity route dead (the stub says a different, non-zero identity for the spelling): the folded path alone rejects", async () => {
    const nodes = base();
    const lower = (p: string) => p.toLowerCase();
    for (const p of [DATA, `${DATA}/sub`, USER, DOCS])
      nodes[lower(p)] = { id: [9n, BigInt(5000 + lower(p).length)] };
    await expectAll(lower, nodes);
  });

  it("overlap by identity, a place strictly inside a location under another spelling, and a place that contains a location under another spelling", async () => {
    const nodes = base();
    nodes["/vol/DOCS~1"] = { id: [1n, 20n] }; // the location's root, spelled so that no text matches
    nodes["/vol/DOCS~1/sub"] = { id: [1n, 21n] }; // a folder inside it
    nodes["/vol/VOL~1"] = { id: [1n, 3n] }; // /vol itself, spelled so that no text matches
    const c = ctx({ fs: stubFs(nodes), rules: "posix", locations: [location] });
    expect((await reject("folder", "/vol/DOCS~1/sub", c)).code).toBe("overlaps-location");
    expect((await reject("folder", "/vol/VOL~1", c)).code).toBe("overlaps-location");
  });

  it("NFC and NFD spellings of a name are the same part", async () => {
    const nodes = base();
    nodes["/vol/Docs\u00c9"] = { id: [1n, 6001n] }; // the approved location, precomposed
    nodes["/vol/DocsE\u0301"] = { id: [9n, 6000n] }; // the same letters decomposed: a different folder to the identity route
    const loc = { ...location, realPath: "/vol/Docs\u00c9", rootIno: "6001" };
    const c = ctx({ fs: stubFs(nodes), rules: "posix", locations: [loc] });
    expect((await reject("folder", "/vol/DocsE\u0301", c)).code).toBe("overlaps-location");
  });

  it("an ancestor whose identity cannot be read makes the answer 'inside' (fail closed)", async () => {
    const nodes = base();
    nodes["/vol"] = { id: [1n, 0n] };
    nodes["/vol/Other"] = { id: [1n, 77n] };
    const c = ctx({ fs: stubFs(nodes), rules: "posix", forbidden });
    expect((await reject("folder", "/vol/Other", c)).code).toBe("inside-data-directory");
  });

  it("an ancestor whose stat THROWS makes the answer 'inside' too (fail closed on the error path, not only on a 0)", async () => {
    const nodes = base();
    nodes["/vol"] = { id: [1n, 3n], statThrows: true };
    nodes["/vol/Other"] = { id: [1n, 77n] };
    const c = ctx({ fs: stubFs(nodes), rules: "posix", forbidden });
    expect((await reject("folder", "/vol/Other", c)).code).toBe("inside-data-directory");
  });

  it("a location whose root cannot be read (an unplugged disk) blocks a new approval as overlapping: its chain is unknown, so fail closed", async () => {
    // the stored location's folder (DOCS) is gone
    const nodes = Object.fromEntries(Object.entries(base()).filter(([path]) => path !== DOCS));
    nodes["/vol/Other"] = { id: [1n, 77n] };
    const c = ctx({ fs: stubFs(nodes), rules: "posix", locations: [location] });
    expect((await reject("folder", "/vol/Other", c)).code).toBe("overlaps-location");
  });

  it("an identity with dev 0 and a non-zero ino is unavailable as well", async () => {
    const nodes = base();
    nodes["/vol/Dev0"] = { id: [0n, 5n] };
    const c = ctx({ fs: stubFs(nodes), rules: "posix" });
    expect((await reject("folder", "/vol/Dev0", c)).code).toBe("identity-unavailable");
  });

  it("a stored root identity that is not a number is a closed rejection, not an exception", async () => {
    const nodes = base();
    nodes["/vol/Other"] = { id: [1n, 77n] };
    for (const bad of [
      { rootDev: "abc", rootIno: "20" },
      { rootDev: "1", rootIno: "" },
    ]) {
      const c = ctx({ fs: stubFs(nodes), rules: "posix", locations: [{ ...location, ...bad }] });
      expect((await reject("folder", "/vol/Other", c)).code).toBe("overlaps-location");
    }
  });

  it("a candidate elsewhere on the same volume is approved", async () => {
    const nodes = base();
    nodes["/vol/Other"] = { id: [1n, 77n] };
    const r = await checkApproval(
      { kind: "folder", path: "/vol/Other" },
      ctx({ fs: stubFs(nodes), rules: "posix", forbidden, locations: [location] }),
    );
    expect(r.ok).toBe(true);
  });

  it("on this OS's real file system: the data directory spelled in another case is rejected when the volume ignores case, else the test says it ran on a stub only", async () => {
    mkdirSync(join(root, "Data"));
    const upper = join(root, "DATA");
    let insensitive = false;
    try {
      realpathSync.native(upper);
      insensitive = true;
    } catch {
      /* a case-sensitive volume: the spelling names no folder */
    }
    if (!insensitive) {
      console.info(
        "local-path: this volume is case sensitive; the case-folding route is exercised through the stub only",
      );
      expect((await reject("folder", upper, ctx({ forbidden: [join(root, "Data")] }))).code).toBe(
        "not-found",
      );
      return;
    }
    expect((await reject("folder", upper, ctx({ forbidden: [join(root, "Data")] }))).code).toBe(
      "inside-data-directory",
    );
    // and the forbidden folder itself named in the other case
    expect((await reject("folder", join(root, "Data"), ctx({ forbidden: [upper] }))).code).toBe(
      "inside-data-directory",
    );
  });
});

it("the default file system is the Node one", () => {
  expect(nodeBoundaryFs.constants.O_RDONLY).toBe(0);
});
