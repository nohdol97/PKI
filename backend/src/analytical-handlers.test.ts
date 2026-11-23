// S03-T08 `analytical.api` (handler part, S03-R19, R18), through the handlers directly: the check request queues
// the check job of the table source an item reaches and answers its id; an item the caller may not see, and a
// source it may not see, are the same answer as an absent one, a code with no text; the read is handed the
// caller's visibility and its answer is returned as it is. All data is synthetic.
import {
  insertItem,
  registerConnectorInstance,
  saveDatasetTable,
  saveRelation,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnalyticalApi } from "./analytical-api.ts";
import { openCanonicalDb } from "./composition.ts";

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-analytical-handlers-"));
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "inst", "test-fixtures");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "t",
} as const;
const blocks = [
  { start: 0, end: 2, locator: { format: "csv", record: 1, line: 1, field: 1 } },
  { start: 3, end: 9, locator: { format: "csv", record: 1, line: 1, field: 2 } },
];
function table(name: string) {
  const saved = saveSourceRecord(db, "inst", {
    namespace: "",
    externalId: name,
    title: name,
    body: "id\tamount\n1\t10",
    blocks,
  } as Parameters<typeof saveSourceRecord>[2]);
  if (saved.status !== "created") throw new Error("not stored");
  const item = insertItem(db, { type: "Dataset", name, ...attrs });
  saveDatasetTable(db, { itemId: item, sourceId: saved.sourceId, key: "", rowCount: 1 });
  return { item, sourceId: saved.sourceId };
}
const api = (shown: (kind: string, id: string) => boolean = () => true) => {
  const seen: string[] = [];
  const made = createAnalyticalApi({
    db,
    shown,
    views: {
      listAnalytical: (_db, vis) => {
        seen.push(vis.shown("item", "1") ? "shown" : "hidden");
        return { datasets: [], metrics: [], joins: [], truncated: false };
      },
    },
  });
  return { ...made, seen };
};

describe("analytical.api (handlers)", () => {
  it("C3: the check request queues the table source's job and answers its id, the same id again while it has not run; an item with no table gets none", () => {
    const t = table("orders");
    const lone = insertItem(db, { type: "Metric", name: "m", ...attrs });
    const first = api().check({ itemId: t.item });
    expect(first).toEqual({ jobIds: [expect.any(Number)] });
    expect(api().check({ itemId: t.item })).toEqual(first);
    expect(db.all("SELECT source_id FROM jobs WHERE kind = 'analytical-check'")).toEqual([
      { source_id: t.sourceId },
    ]);
    expect(api().check({ itemId: lone })).toEqual({ jobIds: [] });
  });

  it("C3: a hidden or absent item is not-found with no text, a hidden source queues nothing, and the read is handed the caller's visibility", () => {
    const t = table("orders");
    const hideItem = api((k, id) => !(k === "item" && id === String(t.item)));
    expect(hideItem.check({ itemId: t.item })).toEqual({ error: "not-found" });
    expect(api().check({ itemId: 9999 })).toEqual({ error: "not-found" });
    const hideSource = api((k, id) => !(k === "source" && id === String(t.sourceId)));
    expect(hideSource.check({ itemId: t.item })).toEqual({ jobIds: [] });
    expect(db.all("SELECT 1 FROM jobs WHERE kind = 'analytical-check'")).toEqual([]);

    const reader = api((k) => k !== "item");
    expect(reader.list()).toEqual({ datasets: [], metrics: [], joins: [], truncated: false });
    expect(reader.seen).toEqual(["hidden"]);
  });

  it("F1: a check request through a hidden relation queues nothing", () => {
    const t = table("orders");
    const metric = insertItem(db, { type: "Metric", name: "m", ...attrs });
    const rel = saveRelation(db, {
      subjectId: metric,
      type: "MEASURED_ON",
      objectId: t.item,
      ...attrs,
    }).id;
    const hidden = api((k, id) => !(k === "relation" && id === String(rel)));
    expect(hidden.check({ itemId: metric })).toEqual({ jobIds: [] });
    expect(api().check({ itemId: metric })).toEqual({ jobIds: [expect.any(Number)] });
  });

  it("D1: a path through a hidden intermediate Dataset or Join queues nothing", () => {
    const t = table("orders");
    const metric = insertItem(db, { type: "Metric", name: "m", ...attrs });
    saveRelation(db, { subjectId: metric, type: "MEASURED_ON", objectId: t.item, ...attrs });
    const join = insertItem(db, { type: "Join", name: "j", ...attrs });
    const other = table("customers");
    saveRelation(db, { subjectId: metric, type: "USES_JOIN", objectId: join, ...attrs });
    saveRelation(db, { subjectId: join, type: "JOIN_RIGHT", objectId: other.item, ...attrs });
    const hideDataset = api((k, id) => !(k === "item" && id === String(t.item)));
    expect(hideDataset.check({ itemId: metric })).toEqual({ jobIds: [expect.any(Number)] });
    const hideJoin = api(
      (k, id) => !(k === "item" && (id === String(join) || id === String(t.item))),
    );
    expect(hideJoin.check({ itemId: metric })).toEqual({ jobIds: [] });
  });
});
