// V02 review B-M1: an import parses its text once, however many Connector
// instances the file names; each instance's Connector gets its own lines only.
// Counted calls, not timing, so the test does not depend on machine load.
import type { ImportRecord } from "@pki/contracts";
import { migrate } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createJsonlConnector } from "./adapters/jsonl-connector.ts";
import { importJsonl } from "./jsonl-import.ts";
import * as lines from "./jsonl-lines.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

vi.mock("./jsonl-lines.ts", async (actual) => {
  const real = await actual<typeof import("./jsonl-lines.ts")>();
  return { ...real, parseJsonl: vi.fn(real.parseJsonl) };
});

const MAIL = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8").trim(),
) as ImportRecord;
const line = (i: number) => {
  const content = `합성 본문 ${i}`;
  return JSON.stringify({
    ...MAIL,
    connector_instance_id: `conn-${i % 8}`,
    external_id: `e-${i}`,
    content,
    content_hash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
  });
};

it("parses the text once for eight instances, and hands each Connector its own lines", async () => {
  const db = freshDb();
  const configs: unknown[] = [];
  const createConnector = () => {
    const connector = createJsonlConnector();
    return {
      ...connector,
      initialize: (config: unknown) => (configs.push(config), connector.initialize(config)),
    };
  };
  const text = Array.from({ length: 40 }, (_, i) => line(i)).join("\n");
  const result = await importJsonl(db, text, { createConnector });
  expect(result.created).toBe(40);
  expect(lines.parseJsonl).toHaveBeenCalledTimes(1);
  expect(configs).toHaveLength(8);
  for (const config of configs) {
    const { records } = config as { records: ImportRecord[] };
    expect(records).toHaveLength(5);
    expect(new Set(records.map((r) => r.connector_instance_id)).size).toBe(1);
    expect(config).not.toHaveProperty("text");
  }
  db.close();
});
