// I02F-C4 (I02F-R4, #237 FU6): the full rescan answers `instance-busy` when the instance lock is held and so
// no sync could start, and `queued` when it started. Synthetic folder only.
import { routes } from "@pki/contracts";
import { LOCAL_FILES_INSTANCE_ID } from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { tryLockInstance } from "./instance-lock.ts";
import { inProcessNormalizer } from "./local-normalizer.test-support.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "r".repeat(43);

let root: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-rescan-busy-")));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "note.md"), "# Title\n\nsynthetic body\n");
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("the rescan route of a booted backend", () => {
  it("is refused as instance-busy while the instance lock is held, and queued once it is free", async () => {
    booted = await bootBackend({
      dataDir: join(root, "data"),
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [],
      localFiles: { normalizer: inProcessNormalizer() },
    });
    const { server, db } = booted;
    const h = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
    const call = (path: string, body?: unknown) => send(server.port, path, h, "POST", body);
    const approved = await call(routes.approveLocalLocation.path, {
      type: "folder",
      path: join(root, "docs"),
    });
    expect(approved.status).toBe(200);
    const locationId = (approved.body as { id: string }).id;

    // the approval's first sync may hold the lock: take it once it is free
    let release: (() => void) | undefined;
    for (let i = 0; i < 200 && !release; i++) {
      release = tryLockInstance(db, LOCAL_FILES_INSTANCE_ID);
      if (!release) await new Promise((r) => setTimeout(r, 25));
    }
    if (!release) throw new Error("the instance lock was never free");
    const busy = await call(routes.rescanLocalLocation.path, { locationId });
    release();
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ error: "instance-busy" });

    const started = await call(routes.rescanLocalLocation.path, { locationId });
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ outcome: "queued" });
  }, 30_000);
});
