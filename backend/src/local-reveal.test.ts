// I02B-T04 T10 (I02B-R39, C28 evidence half, C29): "지금 위치" and "폴더에서 보기" are answered from the index
// by the source version the screen holds. The absolute path exists only for the shell channel (`revealPathOf`);
// the info answer carries the relative path and a flag, never a path on the disk (P6, P7).
import { closeLocation, registerConnectorInstance, saveSourceRecord } from "@pki/storage";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeUpserts, world, type World } from "./local-files-connector.test-support.ts";
import { revealPathOf, revealRequest, sourceInfoOf } from "./local-reveal.ts";

const worlds: World[] = [];
afterEach(() => void worlds.splice(0).forEach((w) => w.close()));

async function seeded() {
  const w = world();
  worlds.push(w);
  w.write("docs/a.md", "# a\n\nbody of a\n");
  storeUpserts(w, await w.settle());
  const versionId = Number(w.db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
  return { w, versionId };
}

describe("a local source's present location", () => {
  it("the info names the relative path, the path to reveal is the file's, and a closed location changes the flag", async () => {
    const { w, versionId } = await seeded();
    expect(sourceInfoOf(w.db, versionId)).toEqual({
      local: true,
      relativePath: "docs/a.md",
      state: "active",
      notFound: false,
    });
    expect(revealPathOf(w.db, versionId, () => true)).toBe(join(w.root, "docs/a.md"));
    // I02F-C2: a version the read gate does not show has no path to reveal
    expect(revealPathOf(w.db, versionId, () => false)).toBeUndefined();
    // the answer the page gets holds no absolute path
    expect(JSON.stringify(sourceInfoOf(w.db, versionId))).not.toContain(w.root);

    closeLocation(w.db, w.locationId, "paused", null);
    expect(sourceInfoOf(w.db, versionId)).toMatchObject({ state: "paused", notFound: false });
    closeLocation(w.db, w.locationId, "unavailable", "root-missing");
    expect(sourceInfoOf(w.db, versionId)).toMatchObject({ state: "unavailable", notFound: true });
  });

  it("an index path that leaves the folder is never revealed", async () => {
    const { w, versionId } = await seeded();
    w.db.run("UPDATE local_file_entries SET relative_path = '../outside.md', path_hash = 'x'");
    expect(revealPathOf(w.db, versionId, () => true)).toBeUndefined();
  });

  it("a source of another connector, or an unknown version, is not local and has nothing to reveal", async () => {
    const { w } = await seeded();
    registerConnectorInstance(w.db, "c", "test-fixtures");
    saveSourceRecord(w.db, "c", { externalId: "x", title: "t", body: "b" });
    const other = Number(w.db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
    for (const id of [other, 99999]) {
      expect(sourceInfoOf(w.db, id)).toEqual({
        local: false,
        relativePath: null,
        state: null,
        notFound: false,
      });
      expect(revealPathOf(w.db, id, () => true)).toBeUndefined();
    }
  });
});

describe("the shell channel's request", () => {
  it("takes exactly a request id and a positive whole version id", () => {
    expect(revealRequest({ type: "reveal-request", id: 3, sourceVersionId: 7 })).toEqual({
      id: 3,
      sourceVersionId: 7,
    });
    for (const bad of [
      { type: "reveal-request", id: 3, sourceVersionId: "/etc/passwd" },
      { type: "reveal-request", id: 3, sourceVersionId: 7, path: "/x" },
      { type: "reveal-request", id: 0, sourceVersionId: 7 },
      { type: "stop" },
    ]) {
      expect(revealRequest(bad)).toBeUndefined();
    }
  });
});
