// I02B-T04 T3 (I02B-R10, R8; C13 pause half): the pause and resume of a location through the handler.
// A paused location is not read: a file edited and one deleted give no change in two syncs, and both
// arrive after the resume. The confirmation of held deletions is by the count the user saw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { unlinkSync } from "node:fs";
import { createLocalLocations, createApprovalTickets } from "./local-locations.ts";
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
  const locations = createLocalLocations({
    db: w.db,
    index: w.index,
    forbidden: [w.dataDir],
    buildKind: "test",
    tickets: createApprovalTickets(),
    onApproved: vi.fn(),
    normalizerUnavailable: () => false,
  });
  return { w, locations };
};
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

describe("pause and resume", () => {
  it("a paused location gives no change for an edit and a deletion; resumed, both arrive", async () => {
    const { w, locations } = make();
    w.write("a.md", "# a\n\nbody of a\n");
    w.write("b.md", "# b\n\nbody of b\n");
    storeUpserts(w, await w.settle());

    expect(locations.pause({ locationId: w.locationId })).toMatchObject({ state: "paused" });
    w.write("a.md", "# a\n\nbody of a, edited\n");
    unlinkSync(`${w.root}/b.md`);
    expect([...(await w.sync()), ...(await w.sync())]).toEqual([]);

    expect(locations.resume({ locationId: w.locationId })).toMatchObject({ state: "active" });
    const after = [...(await w.sync()), ...(await w.sync()), ...(await w.sync())];
    expect(upserts(after)).toHaveLength(1);
    expect(deletes(after)).toHaveLength(1);
  });

  it("only a paused location resumes, an unknown one is not found, and the held count must match (I02B-R8)", () => {
    const { w, locations } = make();
    expect(locations.resume({ locationId: w.locationId })).toEqual({ error: "bad-request" });
    expect(locations.pause({ locationId: "x".repeat(22) })).toEqual({ error: "not-found" });
    expect(locations.confirmDeletions({ locationId: w.locationId, count: 3 })).toEqual({
      error: "count-mismatch",
    });
    expect(locations.confirmDeletions({ locationId: w.locationId, count: 0 })).toMatchObject({
      state: "active",
    });
  });
});
