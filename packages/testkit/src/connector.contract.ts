// V01-R7 Connector contract: the suite every Connector implementation runs from
// its own test file, given a factory and a config that initializes it.
import { ChangeSetSchema, type Connector, type SourceRecord } from "@pki/contracts";
import { beforeEach, describe, expect, it } from "vitest";

const signal = () => new AbortController().signal;

async function readAll(connector: Connector, limit: number) {
  const records: SourceRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const set = ChangeSetSchema.parse(
      await connector.getChanges(cursor, { limit, signal: signal() }),
    );
    expect(set.changes.length).toBeLessThanOrEqual(limit);
    for (const change of set.changes) if (change.kind === "upsert") records.push(change.record);
    cursor = set.nextCursor;
    if (!set.hasMore) return { records, cursor };
  }
  throw new Error("getChanges never reported hasMore: false");
}

export function connectorContract(name: string, create: () => Connector, config: unknown): void {
  describe(`Connector contract: ${name}`, () => {
    let connector: Connector;

    beforeEach(async () => {
      connector = create();
      await connector.initialize(config);
    });

    it("declares its type, schema version and capabilities", () => {
      const { type, schemaVersion, capabilities } = connector.manifest;
      expect(type).toMatch(/\S/);
      expect(Number.isInteger(schemaVersion) && schemaVersion >= 1).toBe(true);
      for (const key of ["incremental", "deletes", "accessScope", "fullRescan"] as const) {
        expect(typeof capabilities[key]).toBe("boolean");
      }
    });

    it("is healthy once initialized", async () => {
      expect(await connector.healthCheck()).toEqual({ state: "ok" });
    });

    it("delivers the same records whatever the page size, each external id once", async () => {
      const whole = await readAll(connector, 1000);
      const paged = await readAll(connector, 1);
      expect(whole.records.length).toBeGreaterThan(0);
      expect(paged.records).toEqual(whole.records);
      const ids = whole.records.map((r) => r.externalId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("returns nothing new from the final cursor when incremental", async () => {
      if (!connector.manifest.capabilities.incremental) return;
      const { cursor } = await readAll(connector, 1000);
      const next = await connector.getChanges(cursor, { limit: 1000, signal: signal() });
      expect(next.changes).toEqual([]);
      expect(next.hasMore).toBe(false);
    });

    it("returns each delivered record by external id, and null for an unknown id", async () => {
      const { records } = await readAll(connector, 1000);
      for (const record of records) {
        expect(await connector.getDocument(record.externalId)).toEqual(record);
      }
      expect(await connector.getDocument("contract-unknown-external-id")).toBeNull();
    });

    it("rejects a getChanges call whose signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        connector.getChanges(null, { limit: 10, signal: controller.signal }),
      ).rejects.toThrow();
    });
  });
}
