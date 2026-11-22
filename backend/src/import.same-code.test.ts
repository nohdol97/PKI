// I01-R24, C3 `import.api` ③: the file collector and the import API read a JSONL text with the
// same parse function and store its changes with the same page store function. Both are spied
// on; the same text must reach each spy from both paths with equal changes.
import { JSONL_IMPORT_KIND, parseJsonl } from "@pki/connector-sdk";
import type { ImportRecord } from "@pki/contracts";
import type { SqlDriver } from "@pki/storage";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createJsonlConnector } from "./adapters/jsonl-connector.ts";
import { openCanonicalDb } from "./composition.ts";
import { createConnectorManager } from "./connectors.ts";
import { importContent } from "./imports.ts";
import { storePage } from "./page-store.ts";

vi.mock("@pki/connector-sdk", async (original) => {
  const real = await original<typeof import("@pki/connector-sdk")>();
  return { ...real, parseJsonl: vi.fn(real.parseJsonl) };
});
vi.mock("./page-store.ts", async (original) => {
  const real = await original<typeof import("./page-store.ts")>();
  return { ...real, storePage: vi.fn(real.storePage) };
});

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-import-same-"));
  db = openCanonicalDb(join(dir, "data"));
  vi.mocked(parseJsonl).mockClear();
  vi.mocked(storePage).mockClear();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const content = "Synthetic body";
const record: ImportRecord = {
  id: "syn-1",
  source_type: "wiki",
  external_id: "page-1",
  title: "Synthetic page",
  content,
  author: "writer@example.test",
  participants: [],
  thread_id: "",
  source_url: "https://wiki.example.test/1",
  created_at: "2026-11-01T09:00:00+09:00",
  updated_at: "2026-11-02T09:00:00+09:00",
  content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  version: 1,
  access_scope: ["org:all"],
  metadata: {},
  connector_instance_id: "conn-w",
  operation: "upsert",
  schema_version: "1",
};
const TEXT = [JSON.stringify(record), JSON.stringify({ ...record, external_id: "page-2" })].join(
  "\n",
);

it("both paths call the one parse function and the one page store with equal changes", async () => {
  const path = join(dir, "same.jsonl");
  writeFileSync(path, TEXT);
  const m = await createConnectorManager(
    db,
    [{ id: "file", kind: JSONL_IMPORT_KIND, config: { path } }],
    { [JSONL_IMPORT_KIND]: createJsonlConnector },
  );
  await m.sync("file");
  expect(parseJsonl).toHaveBeenCalledTimes(1);
  expect(storePage).toHaveBeenCalledTimes(1);
  const [fileTarget, filePage] = vi.mocked(storePage).mock.calls[0] ?? [];

  await importContent(db, "api", TEXT);
  expect(parseJsonl).toHaveBeenCalledTimes(2);
  expect(storePage).toHaveBeenCalledTimes(2);
  const [apiTarget, apiPage] = vi.mocked(storePage).mock.calls[1] ?? [];

  expect(apiPage?.changes).toEqual(filePage?.changes);
  expect(apiPage?.changes).toHaveLength(2);
  // judged by the same declaration of what the Connector may do
  expect(apiTarget?.capabilities).toEqual(fileTarget?.capabilities);
  expect(apiTarget?.kind).toBe(fileTarget?.kind);
});
