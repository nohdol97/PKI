// I02B-T03a: the `local-files` connector over its ports (one representative case per criterion; the
// clauses not tested are listed in the PR as deferred). The index is the canonical one on an in-memory
// database, the file system is a real temporary folder, the normalizer is the in-process one or a stand-in.
import { blocksValid, SourceRecordSchema, type LocalIndexPort } from "@pki/contracts";
import { normalizeDocument } from "@pki/document-normalize";
import { createLocalFileIndex, type LocalFileIndex } from "@pki/storage";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_SKIP_REASONS } from "@pki/contracts";
import {
  deletes,
  upserts,
  userDeletes,
  world,
  type World,
} from "./local-files-connector.test-support.ts";

const MD = "# Plan\n\nThe launch is on Friday.\n";
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const worlds: World[] = [];
const make = (options?: Parameters<typeof world>[0]) => {
  const w = world(options);
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});
const entryAt = (w: World, rel: string) =>
  w.index.entriesOfLocation(w.locationId).find((e) => e.relativePath === rel);
const skipRows = (w: World) =>
  w.index
    .entriesOfLocation(w.locationId)
    .filter((e) => e.state === "skipped")
    .map((e) => [e.relativePath, e.skipReason]);

describe("the canonical index satisfies the port (compile-time)", () => {
  it("assigns", () => {
    const w = make();
    const port: typeof w.ports.index = createLocalFileIndex(w.db);
    expect(port.lastSeq()).toBe(0);
  });

  // IGT-C1: the port's methods are declared with method syntax, so the assignment above checks their
  // arguments loosely; the write arguments must be the same types on both sides (#179 FU2).
  it("the write arguments of the index and of the port are the same types", () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const update: Same<
      Parameters<LocalFileIndex["updateEntry"]>,
      Parameters<LocalIndexPort["updateEntry"]>
    > = true;
    const insert: Same<
      Parameters<LocalFileIndex["insertEntry"]>,
      Parameters<LocalIndexPort["insertEntry"]>
    > = true;
    // Mutual assignability lets an OPTIONAL field on one side through, so the key sets are compared too.
    type Arg<F extends (...a: never[]) => unknown, I extends number> = Parameters<F>[I];
    const updateKeys: Same<
      keyof Arg<LocalFileIndex["updateEntry"], 2>,
      keyof Arg<LocalIndexPort["updateEntry"], 2>
    > = true;
    const insertKeys: Same<
      keyof Arg<LocalFileIndex["insertEntry"], 0>,
      keyof Arg<LocalIndexPort["insertEntry"], 0>
    > = true;
    expect([update, insert, updateKeys, insertKeys]).toEqual([true, true, true, true]);
  });
});

describe("C2 records", () => {
  it("markdown and docx become records without an absolute path, blocks as the normalizer's", async () => {
    const w = make();
    w.write("plan.md", MD);
    const docx = readFileSync(
      resolve(import.meta.dirname, "../../fixtures/documents/normal-docx.docx"),
    );
    w.write("memo.docx", docx);
    const records = upserts(await w.settle());
    expect(records.map((r) => (r.metadata as { format: string }).format).sort()).toEqual([
      "docx",
      "markdown",
    ]);
    for (const record of records) {
      expect(SourceRecordSchema.safeParse(record).success).toBe(true);
      expect(blocksValid(record.body, record.blocks ?? [])).toBe(true);
      expect(JSON.stringify(record)).not.toContain(w.root);
      expect(record.namespace).toBe(w.locationId);
      expect(record.externalId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(record.sourceType).toBe("file");
    }
    const md = records.find((r) => (r.metadata as { format: string }).format === "markdown");
    const normalized = await normalizeDocument({
      kind: "bytes",
      bytes: Buffer.from(MD),
      name: "plan.md",
    });
    expect(normalized.ok && md?.blocks).toEqual(normalized.ok && normalized.document.blocks);
  });
});

describe("C32 DOCX comments", () => {
  it("the comment authors become the record's participants and the comment locators pass the schema", async () => {
    const w = make();
    w.write(
      "review.docx",
      readFileSync(
        resolve(import.meta.dirname, "../../fixtures/documents/normal-docx-comments.docx"),
      ),
    );
    const [record] = upserts(await w.settle());
    expect(SourceRecordSchema.safeParse(record).success).toBe(true);
    expect(record?.participants).toEqual(["나", "가", "다"]);
    expect(record?.blocks?.some((b) => b.locator.format === "docx" && b.locator.comment)).toBe(
      true,
    );
  });
});

describe("C4 the outside never enters", () => {
  it("a symlink and the data directory add no record and no index row", async () => {
    const w = make();
    writeFileSync(`${w.outside}/marker.md`, "# outside\n\nOUTSIDE-MARKER\n");
    symlinkSync(`${w.outside}/marker.md`, `${w.root}/link.md`);
    w.write("pki-data/secrets.json", '{"k":"DATA-DIR-MARKER"}');
    w.write("ok.md", MD);
    const changes = await w.settle();
    expect(JSON.stringify(changes)).not.toContain("OUTSIDE-MARKER");
    expect(JSON.stringify(changes)).not.toContain("DATA-DIR-MARKER");
    expect(skipRows(w)).toEqual([["link.md", "symlink"]]);
    expect(entryAt(w, "pki-data/secrets.json")).toBeUndefined();
    expect(upserts(changes)).toHaveLength(1);
  });

  it("a name swapped to an outside file between the walk and the open is refused (redirected)", async () => {
    const w = make();
    w.write("swap.md", MD);
    await w.settle();
    writeFileSync(`${w.outside}/marker.md`, "# outside\n\nOUTSIDE-MARKER\n");
    w.write("swap.md", "# changed\n\nnew text\n");
    await w.sync();
    w.hooks.redirect = { path: `${w.root}/swap.md`, to: `${w.outside}/marker.md`, lstats: 0 };
    const changes = await w.sync();
    expect(JSON.stringify(changes)).not.toContain("OUTSIDE-MARKER");
    const entry = entryAt(w, "swap.md");
    expect(entry?.skipReason).toBe("redirected");
    expect(entry?.contentHash).not.toBe(sha("# outside\n\nOUTSIDE-MARKER\n"));
  });
});

describe("C6 / C7 identity and change detection", () => {
  it("a rename keeps the source id and raises the revision", async () => {
    const w = make();
    w.write("a.md", MD);
    const first = upserts(await w.settle());
    mkdirSync(`${w.root}/sub`);
    renameSync(`${w.root}/a.md`, `${w.root}/sub/a.md`);
    const changes = await w.sync();
    expect(deletes(changes)).toHaveLength(0);
    const [moved] = upserts(changes);
    expect(moved?.externalId).toBe(first[0]?.externalId);
    expect(moved?.revision).toBe((first[0]?.revision ?? 0) + 1);
    expect(entryAt(w, "sub/a.md")?.externalId).toBe(first[0]?.externalId);
  });

  it("an mtime-only change is silent, a content change bumps the revision, a version bump re-announces", async () => {
    const w = make();
    w.write("a.md", MD);
    const first = upserts(await w.settle())[0];
    const later = new Date(Date.now() - 1_800_000);
    utimesSync(`${w.root}/a.md`, later, later);
    expect(upserts(await w.sync())).toHaveLength(0);
    expect(upserts(await w.sync())).toHaveLength(0);
    expect(entryAt(w, "a.md")?.revision).toBe(first?.revision);
    w.write("a.md", `${MD}More.\n`);
    const edited = upserts(await w.settle());
    expect(edited[0]?.revision).toBe((first?.revision ?? 0) + 1);
    w.version.value += 1;
    const reannounced = upserts(await w.sync());
    expect(reannounced[0]?.revision).toBe((edited[0]?.revision ?? 0) + 1);
  });
});

describe("C9 a file still growing is not read", () => {
  it("is read only after two equal observations settleMs apart", async () => {
    const w = make();
    w.write("big.md", MD);
    await w.sync();
    w.write("big.md", `${MD}growing\n`);
    await w.sync();
    w.write("big.md", `${MD}growing more\n`);
    await w.sync();
    expect(w.calls).toEqual([]);
    expect(entryAt(w, "big.md")).toBeUndefined();
    await w.sync();
    expect(w.calls).toEqual(["big.md"]);
  });
});

describe("C10 ignored names and unsupported formats", () => {
  it("counts ignored names, keeps unsupported formats as skip rows", async () => {
    const w = make();
    w.write(".DS_Store", "x");
    w.write("old.hwp", "x");
    w.write("a.md", MD);
    await w.settle();
    expect(skipRows(w)).toEqual([["old.hwp", "unsupported-format"]]);
    const report = w.reports.at(-1)?.locations[0];
    expect(report).toMatchObject({ ignored: 2, skipped: 1, sourced: 1, walked: 4 });
  });
});

describe("C14 the file limit", () => {
  it("flags limit-exceeded and announces no deletion", async () => {
    const w = make();
    for (let i = 1; i <= 8; i++) w.write(`f${i}.md`, `# ${i}\n`);
    await w.settle();
    w.limits.walk.maxFilesPerLocation = 5;
    renameSync(`${w.root}/f1.md`, `${w.outside}/f1.md`);
    const changes = await w.sync();
    expect(deletes(changes)).toHaveLength(0);
    expect(w.reports.at(-1)?.locations[0]?.limitExceeded).toBe(true);
  });
});

describe("C20 / C47 / C52 normalizer outcomes", () => {
  it("a time bomb does not stop the pass and is no rejected entry", async () => {
    const w = make();
    for (const n of ["a", "b", "c"]) w.write(`${n}.md`, `# ${n}\n`);
    w.normalizeAs = (name) =>
      name === "b.md" ? { ok: false, error: { code: "timed-out" } } : undefined;
    await w.settle();
    const page = await w.connector.getChanges(null, {
      limit: 100,
      signal: new AbortController().signal,
    });
    expect(upserts(page.changes)).toHaveLength(2);
    expect(page.rejected ?? []).toEqual([]);
    expect(skipRows(w)).toEqual([["b.md", "timed-out"]]);
  });

  it("every skip reason has a retry class; a timed-out file waits for a change, a locked one is re-read", async () => {
    for (const reason of Object.keys(LOCAL_SKIP_REASONS)) {
      expect(["every-pass", "on-change"]).toContain(
        LOCAL_SKIP_REASONS[reason as keyof typeof LOCAL_SKIP_REASONS].retry,
      );
    }
    const w = make();
    w.write("slow.md", "# slow\n");
    w.write("busy.md", "# busy\n");
    w.normalizeAs = (name) =>
      name === "slow.md" ? { ok: false, error: { code: "timed-out" } } : undefined;
    w.hooks.locked.add(`${w.root}/busy.md`);
    await w.settle();
    expect(skipRows(w).sort()).toEqual([
      ["busy.md", "locked"],
      ["slow.md", "timed-out"],
    ]);
    w.calls.length = 0;
    w.hooks.locked.clear();
    const changes = await w.sync();
    expect(w.calls).toEqual(["busy.md"]);
    expect(upserts(changes).map((r) => r.title)).toEqual(["busy"]);
    const later = new Date(Date.now() - 1_000_000);
    utimesSync(`${w.root}/slow.md`, later, later);
    w.calls.length = 0;
    await w.settle();
    expect(w.calls).toEqual(["slow.md"]);
  });

  it("a broken host stops the pass, rewrites what it blamed, and recovers when repaired", async () => {
    const w = make();
    for (let i = 0; i < 10; i++) w.write(`f${i}.md`, `# ${i}\n`);
    let n = 0;
    w.normalizeAs = () => {
      n += 1;
      if (n < 3) return { ok: false, error: { code: "resource-exceeded" }, unexplainedDeath: true };
      w.broken.value = true;
      return { ok: false, error: { code: "worker-failed" }, unavailable: true };
    };
    const first = await w.settle();
    expect(upserts(first)).toHaveLength(0);
    const rows = skipRows(w);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.filter(([, r]) => r === "resource-exceeded")).toEqual([]);
    expect(w.reports.at(-1)?.normalizerUnavailable).toBe(true);
    w.broken.value = false;
    w.normalizeAs = () => undefined;
    const repaired = await w.sync();
    expect(upserts(repaired)).toHaveLength(10);
    expect(skipRows(w)).toEqual([]);
    expect(w.reports.at(-1)?.normalizerUnavailable).toBe(false);
  });
});

describe("C21 deletions are replayed", () => {
  it("a deletion is announced again from a null cursor", async () => {
    const w = make();
    w.write("a.md", MD);
    w.write("b.md", "# b\n");
    await w.settle();
    renameSync(`${w.root}/a.md`, `${w.outside}/a.md`);
    const first = deletes(await w.sync());
    expect(first).toHaveLength(1);
    const again = await w.sync({ cursor: null });
    expect(deletes(again)).toHaveLength(1);
    const row = w.db.all(
      "SELECT relative_path, content_hash FROM local_file_entries WHERE state = 'deleted'",
    );
    expect(row).toEqual([{ relative_path: null, content_hash: null }]);
  });
});

describe("C42 / C44 races", () => {
  it("a user deletion between the index read and the write wins (scan)", async () => {
    const w = make();
    w.write("a.md", MD);
    await w.settle();
    const id = entryAt(w, "a.md")?.externalId as string;
    w.write("a.md", `${MD}edited\n`);
    await w.sync();
    const real = w.ports.index;
    let deleted = false;
    w.ports = {
      ...w.ports,
      index: {
        ...real,
        entriesOfLocation: (location) => {
          const entries = real.entriesOfLocation(location);
          if (!deleted) userDeletes(w, id);
          deleted = true;
          return entries;
        },
      },
    };
    await w.connector.initialize({});
    const changes = await w.sync();
    expect(upserts(changes)).toHaveLength(0);
    expect(w.index.entryOf(id)?.state).toBe("forgotten");
    expect(w.index.entriesOfLocation(w.locationId)).toHaveLength(1);
  });

  it("a user deletion while the file is being normalized discards its emit", async () => {
    const w = make();
    w.write("a.md", MD);
    await w.sync();
    w.normalizeAs = () => {
      userDeletes(w, entryAt(w, "a.md")?.externalId as string);
      return undefined;
    };
    const changes = await w.sync();
    expect(upserts(changes)).toHaveLength(0);
  });

  it("bytes changed between the hash and the emit are not emitted, and the next pass announces the new ones", async () => {
    const w = make();
    w.write("a.md", MD);
    w.hooks.beforeOpen = (path, nth) => {
      if (nth === 2 && path.endsWith("a.md")) writeFileSync(path, `${MD}changed after hashing\n`);
    };
    await w.sync();
    const changes = await w.sync();
    expect(upserts(changes)).toHaveLength(0);
    expect(entryAt(w, "a.md")?.mtimeNs).toBeNull();
    const after = upserts(await w.settle());
    expect(after).toHaveLength(1);
    expect(after[0]?.body).toContain("changed after hashing");
    expect(after[0]?.revision).toBeGreaterThan(1);
  });
});
