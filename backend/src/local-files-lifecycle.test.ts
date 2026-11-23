// I02B-T04 T0 (F1, FU7): what a location that is not read owes the connector when it is read again.
// One representative case per clause; the connector runs over the canonical index on an in-memory database.
import { unlinkSync } from "node:fs";
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
      w.connector.getDocument?.({ namespace: w.locationId, externalId: record!.externalId });
    expect(await ask()).not.toBeNull();
    w.pause();
    expect(await ask()).toBeNull();
  });
});
