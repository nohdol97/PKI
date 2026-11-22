// I04-R17: no source may exist whose deletion cannot be written to the ledger. The one limit on an
// instance id (contracts MAX_INSTANCE_ID_LENGTH) is enforced at import; a source that already has an
// id or kind the ledger cannot record answers the delete with its own 409, nothing changed; every
// registered connector kind satisfies the ledger's kind rule.
import { routes, MAX_INSTANCE_ID_LENGTH } from "@pki/contracts";
import { defaultEntries } from "@pki/knowledge-engine";
import {
  LedgerLineUnwritableError,
  draftReadable,
  registerConnectorInstance,
  saveSourceRecord,
} from "@pki/storage";
import { send } from "@pki/testkit";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SITE_CONNECTOR_KINDS } from "./public-kinds.ts";
import { bootBackend } from "./boot.ts";
import {
  fixtureConnectorKinds,
  openCanonicalDb,
  productConnectors,
  productImporter,
} from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "d".repeat(43);
let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-id-limit-"))));
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const line = (patch: Record<string, unknown>) => {
  const content = String(patch.content ?? "합성 본문");
  return JSON.stringify({
    id: "syn-1",
    source_type: "wiki",
    external_id: "p1",
    title: "합성 제목",
    content,
    author: "a@example.test",
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
    ...patch,
  });
};
const start = async () =>
  (booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
  }));
const call = (route: { path: string }, body?: unknown) => {
  const port = (booted as NonNullable<typeof booted>).server.port;
  return send(
    port,
    route.path,
    { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` },
    body === undefined ? "GET" : "POST",
    body,
  );
};

describe("the one instance id limit", () => {
  it("an import line with a connector_instance_id over the limit is refused at parse as a schema error; at the limit it is stored", async () => {
    await start();
    const over = await call(routes.importJsonl, {
      text: line({ connector_instance_id: "i".repeat(MAX_INSTANCE_ID_LENGTH + 172) }),
    });
    expect(over.body).toMatchObject({
      created: 0,
      errors: [{ line: 1, reason: "invalid-record" }],
    });
    const at = await call(routes.importJsonl, {
      text: line({ connector_instance_id: "i".repeat(MAX_INSTANCE_ID_LENGTH) }),
    });
    expect(at.body).toMatchObject({ created: 1, errorCount: 0 });
  });

  it("every registered connector kind satisfies the ledger's kind rule", () => {
    const kinds = new Set([
      ...Object.keys(productConnectors().kinds),
      ...Object.keys(fixtureConnectorKinds()),
      ...SITE_CONNECTOR_KINDS,
      "jsonl-import",
      "test-fixtures",
    ]);
    expect(kinds.size).toBeGreaterThanOrEqual(5);
    const draft = (connectorKind: string) => ({
      connectorInstanceId: "i",
      connectorKind,
      identityHash: "0".repeat(64),
      coversVersion: 1,
      lastRevision: null,
      reason: "user-deleted" as const,
      at: "2026-11-22T00:00:00.000Z",
      liftedAt: null,
    });
    for (const kind of kinds) expect([kind, draftReadable(draft(kind))]).toEqual([kind, true]);
  });
});

describe("a source that already has an id the ledger cannot record", () => {
  it("answers the delete with its own 409, and nothing changes (no tombstone, still listed)", async () => {
    const db = openCanonicalDb(dir);
    const longId = "i".repeat(MAX_INSTANCE_ID_LENGTH + 20);
    registerConnectorInstance(db, longId, "jsonl-import");
    saveSourceRecord(db, longId, {
      namespace: "n",
      externalId: "old",
      title: "옛 원본",
      body: "본문",
    });
    db.close();
    await start();

    const res = await call(routes.deleteSource, {
      connectorId: longId,
      namespace: "n",
      externalId: "old",
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "ledger-unwritable" });
    expect(booted?.db.all("SELECT count(*) AS n FROM tombstones")[0]?.n).toBe(0);
    expect(booted?.db.all("SELECT count(*) AS n FROM source_versions")[0]?.n).toBe(1);
  });

  it("an import deletion line whose ledger line cannot be written is reported with its own code, not a bare failure", async () => {
    const db = openCanonicalDb(dir);
    await productImporter(db)(line({}));
    const refusing = {
      ...defaultEntries,
      acceptChange: ((tx, instanceId, change, ...rest) => {
        if (change.kind === "delete") throw new LedgerLineUnwritableError();
        return defaultEntries.acceptChange(tx, instanceId, change, ...rest);
      }) as typeof defaultEntries.acceptChange,
    };
    const result = await productImporter(db, { entries: refusing })(
      line({ operation: "delete", content: "", version: 2 }),
    );
    expect(result.errors).toEqual([{ line: 1, reason: "ledger-unwritable" }]);
    expect(db.all("SELECT count(*) AS n FROM tombstones")[0]?.n).toBe(0);
    db.close();
  });
});
