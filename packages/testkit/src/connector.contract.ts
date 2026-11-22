// Connector contract, SDK v2 (V01-R7, I01-R1/R2/R5): the suite every Connector
// implementation runs from its own test file, given a factory and a config that
// initializes it. I01-T04 replaces it with checkConnector and its violation codes.
import {
  ChangeSetSchema,
  CONNECTOR_SDK_VERSION,
  type Connector,
  type SourceRecord,
} from "@pki/contracts";
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

    it("declares its type, the SDK version and capabilities", () => {
      const { type, schemaVersion, capabilities } = connector.manifest;
      expect(type).toMatch(/\S/);
      expect(schemaVersion).toBe(CONNECTOR_SDK_VERSION);
      for (const key of [
        "incremental",
        "deletes",
        "accessScope",
        "fullRescan",
        "deletionsOnRescan",
      ] as const) {
        expect(typeof capabilities[key]).toBe("boolean");
      }
      if (capabilities.deletionsOnRescan) {
        expect(capabilities.deletes && capabilities.fullRescan).toBe(true);
      }
    });

    it("is healthy once initialized", async () => {
      expect(await connector.healthCheck()).toEqual({ state: "ok" });
    });

    it("delivers the same records whatever the page size, each identity once", async () => {
      const whole = await readAll(connector, 1000);
      const paged = await readAll(connector, 1);
      expect(whole.records.length).toBeGreaterThan(0);
      expect(paged.records).toEqual(whole.records);
      const ids = whole.records.map((r) => JSON.stringify([r.namespace, r.externalId]));
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("writes its records in the SDK version of its manifest", async () => {
      const { records } = await readAll(connector, 1000);
      for (const record of records) {
        expect(record.schemaVersion).toBe(connector.manifest.schemaVersion);
      }
    });

    it("returns nothing new from the final cursor when incremental", async () => {
      if (!connector.manifest.capabilities.incremental) return;
      const { cursor } = await readAll(connector, 1000);
      const next = await connector.getChanges(cursor, { limit: 1000, signal: signal() });
      expect(next.changes).toEqual([]);
      expect(next.hasMore).toBe(false);
    });

    it("returns each delivered record by namespace and external id, and null for an unknown one", async () => {
      const { records } = await readAll(connector, 1000);
      for (const record of records) {
        const { namespace, externalId } = record;
        expect(await connector.getDocument({ namespace, externalId })).toEqual(record);
      }
      expect(
        await connector.getDocument({ namespace: "", externalId: "contract-unknown-external-id" }),
      ).toBeNull();
      const [first] = records;
      if (first) {
        const elsewhere = {
          namespace: `${first.namespace}-contract-other`,
          externalId: first.externalId,
        };
        expect(await connector.getDocument(elsewhere)).toBeNull();
      }
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
