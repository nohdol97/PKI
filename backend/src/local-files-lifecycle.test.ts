// I02B-T04 T0 (F1, FU7): what a location that is not read owes the connector when it is read again.
// One representative case per clause; the connector runs over the canonical index on an in-memory database.
import { confirmDeletions, listLocations, relinkLocation, type LocalLocation } from "@pki/storage";
import { chmodSync, utimesSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deletes,
  storeUpserts,
  upserts,
  world,
  type World,
} from "./local-files-connector.test-support.ts";

const worlds: World[] = [];
const make = () => {
  const w = world();
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});
const page = async (w: World, limit: number) => {
  w.clock.t += 1_500;
  const result = await w.connector.getChanges(w.cursor, {
    limit,
    signal: new AbortController().signal,
  });
  w.cursor = result.nextCursor;
  return result;
};

describe("F1: a location read again announces what it was not read for", () => {
  it("three files, pause after the first page, resume, two syncs: all three become sources", async () => {
    const w = make();
    for (const name of ["a.md", "b.md", "c.md"]) w.write(name, `# ${name}\n\nbody of ${name}\n`);
    await w.sync(); // observed: a new file passes the settle condition on the next pass
    const first = await page(w, 1);
    expect(first.hasMore).toBe(true);
    const announced = first.changes;
    storeUpserts(w, announced);
    w.pause();
    // the rest of the pages are read while paused: the cursor moves past entries that were not announced
    let rest = await page(w, 1);
    while (rest.hasMore) {
      announced.push(...rest.changes);
      rest = await page(w, 1);
    }
    announced.push(...rest.changes);
    w.resume();
    announced.push(...(await w.sync()));
    announced.push(...(await w.sync()));
    storeUpserts(w, announced);
    const ids = upserts(announced).map((r) => r.externalId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toHaveLength(3);
  });

  it("a deletion recorded before a pause is announced after the resume, not during it", async () => {
    const w = make();
    w.write("a.md", "# a\n\nbody of a\n");
    w.write("b.md", "# b\n\nbody of b\n");
    storeUpserts(w, await w.settle());
    w.write("b.md", "# b\n\nbody of b, edited\n");
    await w.sync(); // b is seen changed, not yet settled
    unlinkSync(`${w.root}/a.md`);
    const first = await page(w, 1); // b's change, and a's deletion is recorded in the index
    expect(upserts(first.changes)).toHaveLength(1);
    w.pause();
    const during = await page(w, 10);
    expect(deletes(during.changes)).toHaveLength(0);
    w.resume();
    const after = [...(await w.sync()), ...(await w.sync())];
    expect(deletes(after)).toHaveLength(1);
  });

  it("FU7: a document of a paused location is not read", async () => {
    const w = make();
    w.write("a.md", "# a\n\nbody of a\n");
    const [record] = upserts(await w.settle());
    const ask = () =>
      w.connector.getDocument?.({
        namespace: w.locationId,
        externalId: (record as { externalId: string }).externalId,
      });
    expect(await ask()).not.toBeNull();
    w.pause();
    expect(await ask()).toBeNull();
  });
});

describe("C11: the root of a location", () => {
  const stateOf = (w: World) => {
    const l = listLocations(w.db).find((x) => x.id === w.locationId) as LocalLocation;
    return [l.state, l.stateReason];
  };
  const present = (w: World) =>
    w.index.entriesOfLocation(w.locationId).filter((e) => e.state === "present");

  it("a folder renamed away makes the location unavailable with no deletion, and renamed back it is active again", async () => {
    const w = make();
    w.write("a.md", "# a\n\nbody of a\n");
    w.write("b.md", "# b\n\nbody of b\n");
    storeUpserts(w, await w.settle());
    renameSync(w.root, `${w.root}-away`);
    expect(deletes(await w.sync())).toHaveLength(0);
    expect(stateOf(w)).toEqual(["unavailable", "root-missing"]);
    renameSync(`${w.root}-away`, w.root);
    expect(deletes(await w.sync())).toHaveLength(0);
    expect(stateOf(w)).toEqual(["active", null]);
    expect(present(w)).toHaveLength(2);
  });

  it("another folder at the same path is root-changed, stays so, and a relink to it keeps the internal ids", async () => {
    const w = make();
    w.write("a.md", "# a\n\nbody of a\n");
    storeUpserts(w, await w.settle());
    const idsBefore = present(w).map((e) => e.externalId);
    renameSync(w.root, `${w.root}-old`);
    mkdirSync(join(w.root, "pki-data"), { recursive: true });
    w.write("a.md", "# a\n\nbody of a\n");
    expect(deletes([...(await w.sync()), ...(await w.sync())])).toHaveLength(0);
    expect(stateOf(w)).toEqual(["unavailable", "root-changed"]);
    const stat = statSync(w.root, { bigint: true });
    relinkLocation(w.db, w.locationId, {
      displayPath: w.root,
      realPath: w.root,
      rootDev: stat.dev.toString(),
      rootIno: stat.ino.toString(),
    });
    expect(deletes([...(await w.sync()), ...(await w.sync())])).toHaveLength(0);
    expect(stateOf(w)).toEqual(["active", null]);
    expect(present(w).map((e) => e.externalId)).toEqual(idsBefore);
  });
});

describe("C12: the deletion brake", () => {
  const names = (n: number) =>
    Array.from({ length: n }, (_, i) => `f${String(i).padStart(2, "0")}.md`);
  const seed = async (w: World, n: number) => {
    for (const name of names(n)) w.write(name, `# ${name}\n\nbody of ${name}\n`);
    storeUpserts(w, await w.settle());
  };
  const remove = (w: World, from: number, count: number) => {
    for (const name of names(from + count).slice(from)) unlinkSync(`${w.root}/${name}`);
  };
  const stateOf = (w: World) =>
    (listLocations(w.db).find((x) => x.id === w.locationId) as LocalLocation).state;
  const held = (w: World) =>
    w.index.entriesOfLocation(w.locationId).filter((e) => e.pendingDelete === 1).length;

  it("25 of 40 gone is held, a new file still arrives, the confirmation is by count and then 25 deletions are announced", async () => {
    const w = make();
    await seed(w, 40);
    remove(w, 0, 25);
    w.write("new.md", "# new\n\nbody of new\n");
    const during = [...(await w.sync()), ...(await w.sync())];
    expect(deletes(during)).toHaveLength(0);
    expect(upserts(during)).toHaveLength(1);
    expect(stateOf(w)).toBe("needs-confirmation");
    expect(held(w)).toBe(25);

    expect(confirmDeletions(w.db, w.locationId, 24)).toMatchObject({
      ok: false,
      reason: "count-mismatch",
    });
    expect(held(w)).toBe(25);
    expect(confirmDeletions(w.db, w.locationId, 25)).toMatchObject({ ok: true });
    expect(deletes(await w.sync())).toHaveLength(25);
    expect(stateOf(w)).toBe("active");
  }, 30_000);

  it("50 files with 20 gone (ratio short) and 30 with 19 gone (count short) are deleted at once", async () => {
    const a = make();
    await seed(a, 50);
    remove(a, 0, 20);
    expect(deletes(await a.sync())).toHaveLength(20);
    const b = make();
    await seed(b, 30);
    remove(b, 0, 19);
    expect(deletes(await b.sync())).toHaveLength(19);
  }, 30_000);

  it("FU1: one file gone beside an unreadable folder is exactly one deletion, the folder's files stay", async () => {
    const w = make();
    w.write("a.md", "# a\n\nbody of a\n");
    w.write("sub/s.md", "# s\n\nbody of s\n");
    storeUpserts(w, await w.settle());
    unlinkSync(`${w.root}/a.md`);
    chmodSync(`${w.root}/sub`, 0o000);
    try {
      expect(deletes(await w.sync())).toHaveLength(1);
    } finally {
      chmodSync(`${w.root}/sub`, 0o755);
    }
    expect(
      w.index.entriesOfLocation(w.locationId).filter((e) => e.state === "present"),
    ).toHaveLength(1);
  });
});

describe("FU6 (#179): a rescan from a null cursor", () => {
  it("announces an entry whose size and time were just noted silently, as every rescan announces all", async () => {
    const w = make();
    w.write("a.md", "# a\n\nbody of a\n");
    const [first] = upserts(await w.settle());
    const later = new Date(Date.now() - 1_800_000);
    utimesSync(`${w.root}/a.md`, later, later); // the time alone changed: a silent write in the pass
    await w.sync({ cursor: null }); // the new time is seen, not yet settled
    const rescan = await w.sync({ cursor: null }); // settled: the entry is rewritten silently in this pass
    expect(upserts(rescan).map((r) => r.externalId)).toEqual([first?.externalId]);
  });
});
