// I04-R17 with I01-T05's import paths: a deletion that arrives through an import (`delete`,
// `access-revoked` lines, POST /api/imports) queues a ledger line exactly like a sync's, so a
// restore of an older database applies it again; and a tombstone the re-apply made (the source
// still plain in the restored database, or recreated as hash-only with its instance) fences a
// re-import through /api/imports and the V02 route. Synthetic data only.
import { routes } from "@pki/contracts";
import { LEDGER_FILE, parseLedger } from "@pki/storage";
import { send } from "@pki/testkit";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { CANONICAL_DB_FILE } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "l".repeat(43);
let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-ledger-import-"))));
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const line = (patch: Record<string, unknown>) => {
  const content = String(patch.content ?? "합성 등대 본문");
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
const headers = () => {
  const port = (booted as NonNullable<typeof booted>).server.port;
  return { port, h: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` } };
};
const viaApi = (content: string) => {
  const { port, h } = headers();
  return send(port, routes.imports.path, h, "POST", { instanceId: "api-inst", content });
};
const viaV02 = (text: string) => {
  const { port, h } = headers();
  return send(port, routes.importJsonl.path, h, "POST", { text });
};
const listed = async () => {
  const { port, h } = headers();
  return (
    (await send(port, routes.sources.path, h)).body as { sources: { externalId: string }[] }
  ).sources
    .map((s) => s.externalId)
    .sort();
};
const stop = async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
};
const ledgerLines = () => parseLedger(readFileSync(join(dir, LEDGER_FILE), "utf8")).lines;
const backupNow = () =>
  (booted as NonNullable<typeof booted>).db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
const restore = () => copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));

describe("a deletion through an import has a durable ledger line", () => {
  it("delete and access-revoked lines queue lines with their reasons and the importer's kind, and a restore of an older database applies them", async () => {
    await start();
    expect((await viaApi(line({ external_id: "gone-1" }))).status).toBe(200);
    expect((await viaApi(line({ external_id: "gone-2" }))).status).toBe(200);
    expect((await viaApi(line({ external_id: "stays" }))).status).toBe(200);
    backupNow();

    await viaApi(line({ external_id: "gone-1", operation: "delete", content: "", version: 2 }));
    await viaApi(
      line({ external_id: "gone-2", operation: "access-revoked", content: "", version: 2 }),
    );
    expect(ledgerLines().map((l) => [l.reason, l.connectorInstanceId, l.connectorKind])).toEqual([
      ["source-deleted", "api-inst", "jsonl-import"],
      ["access-revoked", "api-inst", "jsonl-import"],
    ]);
    expect(await listed()).toEqual(["stays"]);
    await stop();

    restore();
    await start();

    expect(await listed()).toEqual(["stays"]);
    const report = JSON.parse(
      (booted as NonNullable<typeof booted>).db.all(
        "SELECT value FROM settings WHERE key = 'tombstone-ledger.report'",
      )[0]?.value as string,
    ) as { applied: number };
    expect(report.applied).toBe(2);
  });
});

const ROUTES = {
  "POST /api/imports": (text: string) => viaApi(text),
  "the V02 import route": (text: string) => viaV02(text),
} as const;

describe.each(Object.entries(ROUTES))(
  "a re-applied tombstone fences a re-import through %s",
  (_name, send) => {
    const record = (patch: Record<string, unknown> = {}) =>
      line({ external_id: "fenced", connector_instance_id: "inst-r", ...patch });
    const del = { operation: "delete", content: "", version: 2 };

    it("with no restore the re-import is refused (the baseline)", async () => {
      await start();
      await send(record());
      await send(record(del));
      expect((await send(record())).body).toMatchObject({ created: 0 });
    });

    it("when the restored database still holds the source plain", async () => {
      await start();
      await send(record());
      backupNow();
      await send(record(del));
      await stop();
      restore();
      await start();
      expect(await listed()).toEqual([]);

      expect((await send(record())).body).toMatchObject({ created: 0 });
      expect(await listed()).toEqual([]);
    });

    it("when the restored database lacks the source and its instance: recreated hash-only with the real kind", async () => {
      await start();
      backupNow(); // before the instance existed
      await send(record());
      await send(record(del));
      await stop();
      restore();
      await start();
      expect(
        (booted as NonNullable<typeof booted>).db.all("SELECT kind FROM connector_instances"),
      ).toEqual([{ kind: "jsonl-import" }]);

      expect((await send(record())).body).toMatchObject({ created: 0 });
      expect(await listed()).toEqual([]);
    });
  },
);
