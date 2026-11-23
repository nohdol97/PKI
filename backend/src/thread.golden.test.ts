// I02B-C31 (R29): the golden threads are already in time order, so after an import `readThread`
// returns each of them in the order of its lines in the file.
import type { ImportRecord } from "@pki/contracts";
import { readThread, type SqlDriver } from "@pki/storage";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productImporter } from "./composition.ts";

const GOLDEN_DIR = resolve(import.meta.dirname, "../../eval/golden/sources");
const GOLDEN = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".jsonl"));

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-thread-"));
  db = openCanonicalDb(join(dir, "data"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("C31 golden threads", () => {
  it.each(GOLDEN)("imports %s and reads every thread back in file order", async (name) => {
    const text = readFileSync(resolve(GOLDEN_DIR, name), "utf8");
    const records = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ImportRecord & { thread_id?: string });
    await productImporter(db, {})(text);
    const deleted = new Set(
      records.filter((r) => r.operation === "delete").map((r) => r.external_id),
    );
    const expected = new Map<string, string[]>();
    for (const r of records) {
      if (r.operation !== "upsert" || !r.thread_id || deleted.has(r.external_id)) continue;
      const key = `${r.connector_instance_id}\u0000${r.thread_id}`;
      const ids = expected.get(key) ?? [];
      if (!ids.includes(r.external_id)) ids.push(r.external_id);
      expected.set(key, ids);
    }
    expect(expected.size).toBeGreaterThan(0);
    for (const [key, ids] of expected) {
      const [instance, thread] = key.split("\u0000") as [string, string];
      expect(readThread(db, instance, thread).messages.map((m) => m.externalId)).toEqual(ids);
    }
  });
});
