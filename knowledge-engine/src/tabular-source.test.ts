// S03-C1 `tabular.contract`: the real TabularSource (it reads a stored version's body
// and blocks) and the memory double both pass the contract suite, on versions built
// from the fixtures in fixtures/documents/ by `@pki/document-normalize`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeDocument } from "@pki/document-normalize";
import { registerConnectorInstance, saveSourceRecord, type SqlDriver } from "@pki/storage";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import {
  MemoryTabularSource,
  TABULAR_CONTRACT_FIXTURES,
  tabularContract,
  type StoredTableVersion,
  type TabularContractFixture,
  type TabularContractHarness,
} from "@pki/testkit";
import { describe, expect, it } from "vitest";
import { sqlTabularSource } from "./tabular-source.ts";

const FIXTURES = fileURLToPath(new URL("../../fixtures/documents/", import.meta.url));

async function normalized(name: string): Promise<StoredTableVersion> {
  const result = await normalizeDocument({
    kind: "bytes",
    bytes: readFileSync(FIXTURES + name),
    name,
  });
  if (!result.ok) throw new Error(`${name}: ${result.error.code}`);
  const { text, blocks, limitations } = result.document;
  return { body: text, blocks, limitations: limitations.map((l) => l.code) };
}

const fixtures = Object.fromEntries(
  await Promise.all(
    TABULAR_CONTRACT_FIXTURES.map(async (name) => [name, await normalized(name)] as const),
  ),
) as Record<TabularContractFixture, StoredTableVersion>;

function openSql(): TabularContractHarness<SqlDriver> {
  const db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "imported", "jsonl-import");
  let n = 0;
  return {
    db,
    source: sqlTabularSource,
    store(version) {
      const saved = saveSourceRecord(db, "imported", {
        externalId: `table-${++n}`,
        title: "table",
        body: version.body,
        ...(version.blocks ? { blocks: version.blocks } : {}),
        provenance: { metadata: { limitations: [...version.limitations] } },
      });
      if (saved.status !== "created") throw new Error(`not stored: ${saved.status}`);
      return { sourceId: saved.sourceId, version: saved.version };
    },
    close: () => db.close(),
  };
}

function openMemory(): TabularContractHarness<undefined> {
  const source = new MemoryTabularSource();
  return {
    db: undefined,
    source,
    store: (version) => source.put(version),
    close: () => undefined,
  };
}

tabularContract("sqlTabularSource", openSql, fixtures);
tabularContract("MemoryTabularSource", openMemory, fixtures);

describe("sqlTabularSource: what the stored version holds", () => {
  it("answers the limitation codes of the version it reads, none when the meta has none", () => {
    const h = openSql();
    try {
      const withCodes = h.store({ ...fixtures["table-xlsx-hidden-sheet.xlsx"] });
      expect(h.source.read(h.db, withCodes, { maxCells: 1000 })?.limitations).toEqual([
        "xlsx.hidden-sheet",
      ]);
      const saved = saveSourceRecord(h.db, "imported", {
        externalId: "no-meta",
        title: "t",
        body: fixtures["table-csv-title-above.csv"].body,
        blocks: fixtures["table-csv-title-above.csv"].blocks as unknown[],
      });
      if (saved.status !== "created") throw new Error("not stored");
      const read = h.source.read(
        h.db,
        { sourceId: saved.sourceId, version: 1 },
        { maxCells: 1000 },
      );
      expect(read?.limitations).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("reads the version named, not the latest", () => {
    const h = openSql();
    try {
      const first = h.store(fixtures["table-csv-title-above.csv"]);
      const saved = saveSourceRecord(h.db, "imported", {
        externalId: "table-1",
        title: "table",
        body: "x",
      });
      expect(saved.status).toBe("created");
      expect(h.source.read(h.db, first, { maxCells: 1000 })?.tables).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});
