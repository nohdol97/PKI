// I02B-T04 T8 (I02B-C22): the three ways a local file's content leaves the product — the file deleted and
// a sync, the user's deletion, the revocation — leave no byte of its path or its text in the data directory
// (the database file, its journal, the ledger). After the user's deletion the next pass makes no new file
// id and lists the file as user-deleted. One booted backend, canaries in the names and in the text.
import { routes, type LocalLocationInfo } from "@pki/contracts";
import { findCanaries, send } from "@pki/testkit";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { inProcessNormalizer } from "./local-normalizer.test-support.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "d".repeat(43);
// no two share a prefix: the full-text index keeps a shared prefix once (canary-files.ts)
const NAMES = ["kwolf-path-4471", "mzeta-path-4471", "qhelix-path-4471"];
const BODIES = ["VOXEL-text-9902", "RUNIC-text-9902", "PLASM-text-9902"];

let root: string;
let running: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-local-delete-")));
});
afterEach(async () => {
  await running?.server.close();
  running?.db.close();
  running = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("C22 the three deletion paths", () => {
  it("leave no canary of a path or a text in the data directory; the user's deletion makes no new file id on the next pass", async () => {
    const docs = join(root, "docs");
    const data = join(root, "data");
    mkdirSync(docs);
    NAMES.forEach((name, i) => {
      writeFileSync(join(docs, `${name}.md`), `# ${name}\n\n${BODIES[i]}\n`);
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(join(docs, `${name}.md`), old, old);
    });
    running = await bootBackend({
      dataDir: data,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [],
      localFiles: { normalizer: inProcessNormalizer() },
    });
    const { db } = running;
    const h = { host: `127.0.0.1:${running.server.port}`, authorization: `Bearer ${TOKEN}` };
    const call = (path: string, body?: unknown) =>
      send(running?.server.port as number, path, h, "POST", body);
    const live = () =>
      Number(
        db.all(
          "SELECT count(*) AS n FROM sources WHERE connector_instance_id = 'local-files' AND identity_hashed = 0",
        )[0]?.n,
      );
    const sync = async (done: () => boolean) => {
      for (let i = 0; i < 20 && (i < 2 || !done()); i++) {
        await new Promise((r) => setTimeout(r, 15));
        await call(routes.syncConnector.path, { connectorId: "local-files" });
      }
    };
    await call(routes.setLocalFilesSettings.path, { settleMs: 1 });
    const location = (await call(routes.approveLocalLocation.path, { type: "folder", path: docs }))
      .body as LocalLocationInfo;
    await sync(() => live() === 3);
    expect(live()).toBe(3);
    const ids = () =>
      db.all("SELECT external_id FROM local_file_entries").map((r) => r.external_id);
    const before = ids().length;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // the search is real: every canary is in the directory while the three files are sources
    expect(new Set(findCanaries(data, [...NAMES, ...BODIES]).map((h) => h.canary)).size).toBe(6);

    // 1. the file is deleted from the disk, and a sync tells
    unlinkSync(join(docs, `${NAMES[0]}.md`));
    await sync(() => live() === 2);
    // 2. the user deletes the second source; the next pass makes no new file id and lists it
    const sources = (await send(running.server.port, routes.sources.path, h, "GET")).body as {
      sources: { connectorId: string; namespace: string; externalId: string; title: string }[];
    };
    const second = sources.sources.find((s) =>
      s.title.includes(NAMES[1] as string),
    ) as (typeof sources.sources)[number];
    const deleted = await call(routes.deleteSource.path, {
      connectorId: second.connectorId,
      namespace: second.namespace,
      externalId: second.externalId,
    });
    expect(deleted.status).toBe(200);
    await sync(() => false);
    expect(ids().length).toBe(before);
    const skipped = (await call(routes.localSkipped.path, { locationId: location.id })).body as {
      items: { reason: string }[];
    };
    expect(skipped.items.map((i) => i.reason)).toEqual(["user-deleted"]);
    // 3. the approval is withdrawn: what is left of the folder goes
    const revoked = await call(routes.revokeLocalLocation.path, {
      locationId: location.id,
      count: 1,
    });
    expect(revoked.body).toEqual({ state: "revoked", revoked: 1 });

    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(findCanaries(data, [...NAMES, ...BODIES])).toEqual([]);
  });
});
