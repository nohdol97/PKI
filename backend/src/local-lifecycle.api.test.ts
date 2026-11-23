// I02B-T04 T5 (I02B-R36; C39 common handler, C13): the lifecycle routes of a booted backend, one round
// trip each way, and the one line in the common handler: a locked ledger answers 409 `ledger-degraded`
// on the existing user deletion, and the body passes the route table's error schema.
import { ErrorResponseSchema, routes, type LocalLocationInfo } from "@pki/contracts";
import { ledgerOf } from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { inProcessNormalizer } from "./local-normalizer.test-support.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "p".repeat(43);
let root: string;
let docs: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-local-life-")));
  docs = join(root, "docs");
  mkdirSync(docs);
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  writeFileSync(join(docs, "note.md"), "# Title\n\nbody of the note\n");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(docs, "note.md"), old, old);
  const running = await bootBackend({
    dataDir: join(root, "data"),
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    localFiles: { normalizer: inProcessNormalizer() },
  });
  booted = running;
  const h = { host: `127.0.0.1:${running.server.port}`, authorization: `Bearer ${TOKEN}` };
  const call = (path: string, body?: unknown) => send(running.server.port, path, h, "POST", body);
  const get = (path: string) => send(running.server.port, path, h, "GET");
  await call(routes.setLocalFilesSettings.path, { settleMs: 1 });
  const approved = (await call(routes.approveLocalLocation.path, { type: "folder", path: docs }))
    .body as LocalLocationInfo;
  // a sync answers `instance-busy` while the settle-triggered one holds the lock (by design), so sync
  // until one runs, then wait for the import to be committed: the source is the observable condition
  await vi.waitFor(
    async () => {
      const synced = await call(routes.syncConnector.path, { connectorId: "local-files" });
      expect((synced.body as { stopped?: string }).stopped).not.toBe("instance-busy");
      const listed = (await get(routes.sources.path)).body as {
        sources: { connectorId: string }[];
      };
      expect(listed.sources.some((s) => s.connectorId === "local-files")).toBe(true);
    },
    { timeout: 30_000, interval: 50 },
  );
  return { call, get, id: approved.id, db: running.db };
}

describe("the lifecycle routes", () => {
  it("pause, resume, a wrong count refused twice, then revoke: one round trip each", async () => {
    const { call, get, id } = await start();
    const stateOf = async () =>
      ((await get(routes.localLocations.path)).body as { locations: LocalLocationInfo[] })
        .locations[0]?.state;

    const paused = await call(routes.pauseLocalLocation.path, { locationId: id });
    expect([paused.status, (paused.body as LocalLocationInfo).state]).toEqual([200, "paused"]);
    expect(
      (await call(routes.pauseLocalLocation.path, { locationId: "x".repeat(22) })).status,
    ).toBe(404);
    const resumed = await call(routes.resumeLocalLocation.path, { locationId: id });
    expect([resumed.status, (resumed.body as LocalLocationInfo).state]).toEqual([200, "active"]);
    expect(await stateOf()).toBe("active");

    const confirm = await call(routes.confirmLocalDeletions.path, { locationId: id, count: 4 });
    expect([confirm.status, confirm.body]).toEqual([409, { error: "count-mismatch" }]);
    const wrong = await call(routes.revokeLocalLocation.path, { locationId: id, count: 5 });
    expect([wrong.status, wrong.body]).toEqual([409, { error: "count-mismatch" }]);
    expect(await stateOf()).toBe("active");

    const revoked = await call(routes.revokeLocalLocation.path, { locationId: id, count: 1 });
    expect([revoked.status, revoked.body]).toEqual([200, { state: "revoked", revoked: 1 }]);
    expect(
      ((await get(routes.localLocations.path)).body as { locations: unknown[] }).locations,
    ).toEqual([]);
  });

  it("the skipped list, a reimport of an unknown file and a relink of an active location answer by the table", async () => {
    const { call, id } = await start();
    const list = await call(routes.localSkipped.path, { locationId: id });
    expect([list.status, list.body]).toEqual([200, { items: [], total: 0 }]);
    const missing = await call(routes.reimportLocalFile.path, {
      locationId: id,
      relativePath: "none.md",
    });
    expect([missing.status, missing.body]).toEqual([404, { error: "not-found" }]);
    const relink = await call(routes.relinkLocalLocation.path, { locationId: id, path: docs });
    expect(relink.status).toBe(400);
    const rescan = await call(routes.rescanLocalLocation.path, { locationId: id });
    expect([rescan.status, rescan.body]).toEqual([200, { outcome: "queued" }]);
  });
});

describe("C39 the common handler", () => {
  it("a locked ledger answers 409 ledger-degraded on the user's deletion, and the body passes the error schema", async () => {
    const { call, get, db } = await start();
    const sources = (await get(routes.sources.path)).body as {
      sources: { connectorId: string; namespace: string; externalId: string }[];
    };
    const source = sources.sources.find((s) => s.connectorId === "local-files");
    expect(source).toBeDefined();
    ledgerOf(db)?.lock();
    const answered = await call(routes.deleteSource.path, {
      connectorId: "local-files",
      namespace: source?.namespace,
      externalId: source?.externalId,
    });
    expect(answered.status).toBe(409);
    expect(ErrorResponseSchema.safeParse(answered.body).success).toBe(true);
    expect(answered.body).toEqual({ error: "ledger-degraded" });
  });
});
