// I02B-T06 (I02B-R3, R42, C34): a `file` location is one document file approved by itself; it follows the
// file as a folder's files are followed, and its deletion is a tombstone. A `.jsonl` file inside a folder is
// not a document: it is skipped as `unsupported-format` (the text of that reason points to "JSONL 파일 추가").
import { statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { insertLocation, newLocalId } from "@pki/storage";
import { afterEach, describe, expect, it } from "vitest";
import { deletes, upserts, world, type World } from "./local-files-connector.test-support.ts";
import { isDocumentFileName } from "./adapters/local-files-connector.ts";

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

/** A world whose one location is the single file `name` of its folder, the other files lying beside it. */
function fileWorld(name: string) {
  const w = world();
  worlds.push(w);
  w.write(name, "# Title\n\nwanted body\n");
  w.write("beside.md", "# Beside\n\nnot approved\n");
  w.db.run("DELETE FROM local_locations");
  const path = join(w.root, name);
  const stat = statSync(path, { bigint: true });
  w.locationId = newLocalId();
  insertLocation(w.db, {
    id: w.locationId,
    type: "file",
    displayPath: path,
    realPath: path,
    rootDev: stat.dev.toString(),
    rootIno: stat.ino.toString(),
    createdAt: "2026-11-23T00:00:00.000Z",
  });
  return w;
}

describe("C34 the file kind", () => {
  it("makes one source from the file and none from its neighbours, follows an edit, and a deleted file is a delete", async () => {
    const w = fileWorld("note.md");
    const first = upserts(await w.settle());
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      namespace: w.locationId,
      revision: 1,
      metadata: { relativePath: "note.md" },
    });
    expect(first[0]?.body).toContain("wanted body");

    w.write("note.md", "# Title\n\nchanged body\n");
    const edited = upserts(await w.settle());
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ externalId: first[0]?.externalId, revision: 2 });

    // the file is gone while the folder that held it reads: the file was deleted, not the disk
    unlinkSync(join(w.root, "note.md"));
    const gone = deletes(await w.settle());
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ namespace: w.locationId, externalId: first[0]?.externalId });
  });

  it("knows a document file by its extension (the eight formats), and a .jsonl file is none", () => {
    for (const name of ["a.md", "b.DOCX", "c.csv", "d.pdf"])
      expect(isDocumentFileName(name)).toBe(true);
    for (const name of ["a.jsonl", "b.hwp", "c"]) expect(isDocumentFileName(name)).toBe(false);
  });
});

describe("C34 .jsonl inside a folder (I02B-R42)", () => {
  it("is not a source: the folder's pass keeps it as a skipped file with the reason unsupported-format", async () => {
    const w = world();
    worlds.push(w);
    w.write("keep.md", "# Keep\n\nbody\n");
    w.write("lines.jsonl", '{"a":1}\n');
    const sources = upserts(await w.settle());
    expect(sources.map((s) => s.metadata?.relativePath)).toEqual(["keep.md"]);
    const skipped = w.index
      .entriesOfLocation(w.locationId)
      .filter((e) => e.state === "skipped")
      .map((e) => [e.relativePath, e.skipReason]);
    expect(skipped).toEqual([["lines.jsonl", "unsupported-format"]]);
  });
});
