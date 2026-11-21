// V02-R2: the JSONL Connector over the V02 synthetic fixtures passes the V01
// Connector contract, emits only its own instance's lines, and never forwards the
// fixtures' malicious marker.
import type { ImportRecord } from "@pki/contracts";
import { connectorContract } from "@pki/testkit";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createJsonlConnector } from "./jsonl-connector.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");
/** Every V02 fixture line; the messenger-type instance has three sources in them. */
const ALL = readdirSync(FIXTURES)
  .filter((f) => /^v02-.*\.jsonl$/.test(f))
  .map(fixture)
  .join("\n");

connectorContract("jsonl-import", createJsonlConnector, {
  text: ALL,
  connectorInstanceId: "conn-v02-chat",
});

const MAIL = JSON.parse(fixture("v02-mail.jsonl").trim()) as ImportRecord;
const hashOf = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
/** The mail fixture with fields replaced; the content hash follows the content. */
const line = (patch: Partial<ImportRecord> & Record<string, unknown> = {}) => {
  const record = { ...MAIL, ...patch };
  return JSON.stringify(
    "content" in patch && !("content_hash" in patch)
      ? { ...record, content_hash: hashOf(record.content) }
      : record,
  );
};
const signal = () => new AbortController().signal;

async function changesOf(text: string, connectorInstanceId = MAIL.connector_instance_id) {
  const connector = createJsonlConnector();
  await connector.initialize({ text, connectorInstanceId });
  return (await connector.getChanges(null, { limit: 1000, signal: signal() })).changes;
}

describe("JSONL Connector", () => {
  it("emits the record's content as the body with its own version as the revision, and no malicious marker", async () => {
    const malicious = fixture("v02-malicious.jsonl");
    expect(malicious).toContain('"malicious":true');
    const changes = await changesOf(malicious);
    expect(changes).toHaveLength(1);
    const [change] = changes;
    expect(change?.kind === "upsert" && Object.keys(change.record).sort()).toEqual([
      "body",
      "externalId",
      "revision",
      "title",
    ]);
    const source = JSON.parse(malicious.split("\n")[0] as string) as ImportRecord;
    expect(change).toEqual({
      kind: "upsert",
      record: {
        externalId: source.external_id,
        title: source.title,
        body: source.content,
        revision: 1,
      },
    });
  });

  it("emits only the lines of its own instance", async () => {
    expect(await changesOf(ALL, "conn-v02-wiki")).toHaveLength(2);
    expect(await changesOf(ALL, "conn-nobody")).toEqual([]);
  });

  it("hands delete and revoke lines on as changes carrying the revision and the time", async () => {
    const at = "2026-11-04T09:00:00+09:00";
    const changes = await changesOf(
      [
        line({ external_id: "d", operation: "delete", content: "", version: 3, updated_at: at }),
        line({ external_id: "r", operation: "revoke", version: 2, updated_at: at }),
      ].join("\n"),
    );
    expect(changes).toEqual([
      { kind: "delete", externalId: "d", version: 3, at },
      { kind: "access-revoked", externalId: "r", version: 2, at },
    ]);
    const connector = createJsonlConnector();
    await connector.initialize({
      text: line({ external_id: "d", operation: "delete", content: "" }),
      connectorInstanceId: MAIL.connector_instance_id,
    });
    expect(await connector.getDocument("d")).toBeNull();
  });

  it("fails to initialize without text and an instance id", async () => {
    await expect(createJsonlConnector().initialize({ text: "" })).rejects.toThrow();
    await expect(createJsonlConnector().initialize({ connectorInstanceId: "c" })).rejects.toThrow();
  });
});
