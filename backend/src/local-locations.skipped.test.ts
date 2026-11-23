// I02B-T04 T6 (I02B-R33, R36; C26, C28 list half): the skipped list and "다시 가져오기". A file the user
// deleted shows in the list from the last pass's report (its path is never stored: C22), and is
// imported again only after its tombstone is lifted, on the same source row.
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSourceId, recordTombstoneLift } from "@pki/storage";
import type { LocalIndexEntry } from "@pki/contracts";
import { createApprovalTickets, createLocalLocations } from "./local-locations.ts";
import {
  storeUpserts,
  upserts,
  userDeletes,
  world,
  type World,
} from "./local-files-connector.test-support.ts";

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});
const make = () => {
  const w = world();
  worlds.push(w);
  const locations = createLocalLocations({
    db: w.db,
    index: w.index,
    forbidden: [w.dataDir],
    buildKind: "test",
    tickets: createApprovalTickets(),
    onApproved: vi.fn(),
    normalizerUnavailable: () => false,
    lastReport: () => w.reports.at(-1),
  });
  return { w, locations };
};
const count = (w: World, sql: string) => Number(w.db.all(sql)[0]?.n);

describe("the skipped list", () => {
  it("lists a skipped file with its reason and a user-deleted file from the last pass, and pages", async () => {
    const { w, locations } = make();
    w.write("a.md", "# a\n\nbody of a\n");
    w.write("old.hwp", "x");
    await w.settle();
    const a = w.index
      .entriesOfLocation(w.locationId)
      .find((e) => e.relativePath === "a.md") as LocalIndexEntry;
    userDeletes(w, a.externalId);
    await w.sync();

    const all = locations.skipped({ locationId: w.locationId, offset: 0, limit: 10 });
    if ("error" in all) throw new Error(all.error);
    expect(all.total).toBe(2);
    expect(all.items.map((i) => [i.relativePath, i.reason]).sort()).toEqual([
      ["a.md", "user-deleted"],
      ["old.hwp", "unsupported-format"],
    ]);
    const page = locations.skipped({ locationId: w.locationId, offset: 1, limit: 1 });
    if ("error" in page) throw new Error(page.error);
    expect([page.total, page.items.length]).toEqual([2, 1]);
  });
});

describe("C26 reimport", () => {
  it("is refused with 409 not-lifted before the lift and puts no plaintext path in the row; after the lift the next sync is a new version of the same source row", async () => {
    const { w, locations } = make();
    w.write("a.md", "# a\n\nbody of a\n");
    await w.settle();
    const a = w.index
      .entriesOfLocation(w.locationId)
      .find((e) => e.relativePath === "a.md") as LocalIndexEntry;
    userDeletes(w, a.externalId);
    await w.sync();

    const request = { locationId: w.locationId, relativePath: "a.md" };
    expect(locations.reimport(request)).toEqual({ error: "not-lifted" });
    const raw = w.db.all("SELECT relative_path FROM local_file_entries WHERE external_id = ?", [
      a.externalId,
    ]);
    expect(raw[0]?.relative_path).toBeNull();

    const sourceId = findSourceId(w.db, "local-files", w.locationId, a.externalId) as number;
    recordTombstoneLift(w.db, sourceId, "2026-11-23T01:00:00.000Z");
    const sourcesBefore = count(w, "SELECT count(*) AS n FROM sources");
    expect(locations.reimport(request)).toEqual({ outcome: "queued" });
    const changes = [...(await w.sync()), ...(await w.sync())];
    expect(upserts(changes).map((r) => r.externalId)).toEqual([a.externalId]);
    storeUpserts(w, changes);
    expect(count(w, "SELECT count(*) AS n FROM sources")).toBe(sourcesBefore);
    expect(
      count(w, `SELECT count(*) AS n FROM source_versions WHERE source_id = ${sourceId}`),
    ).toBe(2);
    expect(locations.reimport({ locationId: w.locationId, relativePath: "none.md" })).toEqual({
      error: "not-found",
    });
  });
});
