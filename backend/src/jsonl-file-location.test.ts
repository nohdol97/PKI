// I02B-T06 (I02B-R41, C33): a JSONL file approved as a `jsonl-file` location is one running `jsonl-import`
// instance `jsonl-file:<location id>`. One booted backend shows the whole life of it: it appears without a
// restart with a default period and syncs, a swapped path is refused, a line cannot reach another instance's
// sources, a revocation removes the instance and deletes its sources as the user's deletion, and a restart
// builds the instances again from the rows. Synthetic data only; the files are real temporary ones.
import { JSONL_IMPORT_KIND } from "@pki/connector-sdk";
import type { ConnectorSummary, ImportRecord } from "@pki/contracts";
import { routes } from "@pki/contracts";
import { registerConnectorInstance, saveSourceRecord, type SqlDriver } from "@pki/storage";
import { send } from "@pki/testkit";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { CONNECTOR_SYNC_KIND } from "./connector-sync-job.ts";
import { inProcessNormalizer } from "./local-normalizer.test-support.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "j".repeat(43);
const MAIL = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8").split(
    "\n",
  )[0] as string,
) as ImportRecord;

const hashOf = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
/** One import line; `connector_instance_id` is the text's claim, which nothing may trust. */
const line = (patch: Partial<ImportRecord>) => {
  const record = { ...MAIL, ...patch };
  return JSON.stringify({ ...record, content_hash: hashOf(record.content) });
};
const lines = (...each: string[]) => `${each.join("\n")}\n`;

let root: string;
let data: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-jsonl-file-")));
  data = join(root, "data");
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(root, { recursive: true, force: true });
});

const file = (name: string, text: string) => {
  const path = join(root, name);
  writeFileSync(path, text);
  return path;
};

async function start() {
  const running = await bootBackend({
    dataDir: data,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    localFiles: { normalizer: inProcessNormalizer() },
  });
  booted = running;
  const h = { host: `127.0.0.1:${running.server.port}`, authorization: `Bearer ${TOKEN}` };
  const call = (path: string, method = "GET", body?: unknown) =>
    send(running.server.port, path, h, method, body);
  return {
    db: running.db,
    call,
    // the approval registers a first sync of the new instance: wait until that job is over, so no test races it
    approve: async (path: string) => {
      const r = await call(routes.approveLocalLocation.path, "POST", { type: "jsonl-file", path });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const id = (r.body as { id: string }).id;
      await vi.waitFor(() =>
        expect(
          running.db.all(
            "SELECT count(*) AS n FROM jobs WHERE kind = ? AND target = ? AND status IN ('queued', 'running', 'retry')",
            [CONNECTOR_SYNC_KIND, `jsonl-file:${id}`],
          )[0]?.n,
        ).toBe(0),
      );
      return id;
    },
    sync: (id: string) =>
      call(routes.syncConnector.path, "POST", { connectorId: `jsonl-file:${id}` }),
    instances: async () =>
      ((await call(routes.connectors.path)).body as { connectors: ConnectorSummary[] }).connectors,
  };
}
const restart = async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  return start();
};

const snapshot = (db: SqlDriver, instance: string) => {
  const n = (sql: string) => Number(db.all(sql, [instance])[0]?.n);
  return {
    sources: n("SELECT count(*) AS n FROM sources WHERE connector_instance_id = ?"),
    versions: n(
      `SELECT count(*) AS n FROM source_versions v JOIN sources s ON s.id = v.source_id
       WHERE s.connector_instance_id = ?`,
    ),
    tombstones: n(
      `SELECT count(*) AS n FROM tombstones t JOIN sources s ON s.id = t.source_id
       WHERE s.connector_instance_id = ?`,
    ),
  };
};

describe("jsonl-file location (I02B-C33): the life of the instance", () => {
  it("appears without a restart with a default period and syncs; a restart keeps it; a revocation removes it and deletes its sources as the user's deletion", async () => {
    const t = await start();
    const path = file(
      "notes.jsonl",
      lines(line({ external_id: "e1", id: "r1" }), line({ external_id: "e2", id: "r2" })),
    );
    const id = await t.approve(path);
    const instance = `jsonl-file:${id}`;

    expect(await t.instances()).toContainEqual({
      id: instance,
      kind: JSONL_IMPORT_KIND,
      state: "ready",
    });
    const periods = booted?.scheduler
      .list()
      .filter((s) => s.kind === CONNECTOR_SYNC_KIND && s.target === instance);
    expect(periods).toHaveLength(1);

    // the first sync, which the approval itself registered, stored both lines; a sync again changes nothing
    expect(snapshot(t.db, instance).sources).toBe(2);
    expect((await t.sync(id)).body).toMatchObject({ connectorId: instance, created: 0 });
    expect(
      t.db.all("SELECT scope_claimed FROM sources WHERE connector_instance_id = ?", [instance]),
    ).toEqual([{ scope_claimed: 1 }, { scope_claimed: 1 }]);

    const again = await restart();
    expect((await again.instances()).map((i) => i.id)).toContain(instance);

    const gone = await again.call(routes.revokeLocalLocation.path, "POST", {
      locationId: id,
      count: 2,
    });
    expect(gone.body).toEqual({ state: "revoked", revoked: 2 });
    expect((await again.instances()).map((i) => i.id)).not.toContain(instance);
    expect(
      booted?.scheduler.list().find((s) => s.kind === CONNECTOR_SYNC_KIND && s.target === instance)
        ?.enabled,
    ).toBe(false);
    expect(
      again.db.all(
        `SELECT count(*) AS n FROM tombstones t JOIN sources s ON s.id = t.source_id
         WHERE s.connector_instance_id = ? AND t.reason = 'user-deleted'`,
        [instance],
      )[0]?.n,
    ).toBe(2);
  });

  it("a restart turns off the period of a jsonl-file instance whose location row is gone, and keeps the live one's (I02B-R53, #258 F2)", async () => {
    const t = await start();
    const goneId = await t.approve(file("gone.jsonl", lines(line({ external_id: "g1" }))));
    const liveId = await t.approve(file("live.jsonl", lines(line({ external_id: "l1", id: "r2" }))));
    const period = (running: NonNullable<typeof booted>, id: string) =>
      running.scheduler
        .list()
        .find((s) => s.kind === CONNECTOR_SYNC_KIND && s.target === `jsonl-file:${id}`);
    expect(period(booted as NonNullable<typeof booted>, goneId)?.enabled).toBe(true);
    // the process died after the revocation's last transaction (the row is gone) and before `revoked()`
    t.db.run("DELETE FROM local_locations WHERE id = ?", [goneId]);

    const again = await restart();
    void again;
    const running = booted as NonNullable<typeof booted>;
    expect(period(running, goneId)?.enabled).toBe(false);
    expect(period(running, liveId)?.enabled).toBe(true);
  });

  it("refuses a path that was swapped for a symlink or for another file, and reads nothing from it", async () => {
    const t = await start();
    const path = file("a.jsonl", lines(line({ external_id: "e1" })));
    const decoy = file("decoy.jsonl", lines(line({ external_id: "decoy" })));
    const id = await t.approve(path);
    const before = snapshot(t.db, `jsonl-file:${id}`); // what the approval's own sync stored

    // another file in the same place (another identity)
    const other = file("other.jsonl", lines(line({ external_id: "swapped" })));
    renameSync(other, path);
    const swapped = await t.sync(id);
    expect(swapped.body).toMatchObject({ stopped: "connector-failed", created: 0 });

    // a symlink to a file in its place
    unlinkSync(path);
    symlinkSync(decoy, path);
    const linked = await t.sync(id);
    expect(linked.body).toMatchObject({ stopped: "connector-failed", created: 0 });
    expect(snapshot(t.db, `jsonl-file:${id}`)).toEqual(before);
  });

  it("a line cannot reach the sources of another jsonl-file location, nor of an older jsonl-import instance, while the paste import still does", async () => {
    const t = await start();
    // an older instance (made by the API import) holding a source in the namespace-less shape
    registerConnectorInstance(t.db, "legacy-1", JSONL_IMPORT_KIND);
    saveSourceRecord(t.db, "legacy-1", {
      namespace: "",
      externalId: "ext-legacy",
      revision: 1,
      title: "old",
      body: "old body",
    });
    const legacyBefore = snapshot(t.db, "legacy-1");

    const idB = await t.approve(file("b.jsonl", lines(line({ external_id: "eb", id: "rb" }))));
    await t.sync(idB);
    const bBefore = snapshot(t.db, `jsonl-file:${idB}`);

    // A's lines name B's instance and the legacy instance, with the identity of an existing source
    const idA = await t.approve(
      file(
        "a.jsonl",
        lines(
          line({ connector_instance_id: `jsonl-file:${idB}`, external_id: "eb", version: 2 }),
          line({
            connector_instance_id: "legacy-1",
            external_id: "ext-legacy",
            version: 2,
            content: "taken over",
          }),
          line({
            connector_instance_id: "legacy-1",
            external_id: "ext-legacy",
            version: 3,
            content: "",
            operation: "delete",
          }),
        ),
      ),
    );
    const synced = await t.sync(idA);
    expect(synced.status).toBe(200);

    expect(snapshot(t.db, `jsonl-file:${idB}`)).toEqual(bBefore);
    expect(snapshot(t.db, "legacy-1")).toEqual(legacyBefore);
    // the lines went into A's own instance, in the namespace they claimed
    expect(snapshot(t.db, `jsonl-file:${idA}`).sources).toBeGreaterThan(0);

    // the same line pasted on the screen goes to the older instance as before (what was not changed is pinned)
    const pasted = await t.call(routes.importJsonl.path, "POST", {
      text: lines(
        line({
          connector_instance_id: "legacy-1",
          external_id: "ext-legacy",
          version: 2,
          content: "pasted",
        }),
      ),
    });
    expect(pasted.status).toBe(200);
    expect(snapshot(t.db, "legacy-1").versions).toBe(legacyBefore.versions + 1);
  });

  it("an approval of something that is not a regular .jsonl file is refused and stores nothing", async () => {
    const t = await start();
    mkdirSync(join(root, "dir.jsonl"));
    const notJsonl = file("a.txt", "x");
    for (const [path, code] of [
      [notJsonl, "unsupported-format"],
      [join(root, "dir.jsonl"), "wrong-type"],
    ] as const) {
      const r = await t.call(routes.approveLocalLocation.path, "POST", {
        type: "jsonl-file",
        path,
      });
      expect(r.status).toBe(422);
      expect(r.body).toEqual({ error: "approval-rejected", code });
    }
    expect((await t.instances()).some((i) => i.id.startsWith("jsonl-file:"))).toBe(false);
    // the booted backend knows the document formats: a document file is approved as a `file` (I02B-C34)
    const doc = file("a.md", "# a\n");
    const approved = await t.call(routes.approveLocalLocation.path, "POST", {
      type: "file",
      path: doc,
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ type: "file", displayPath: doc });
  });
});
