// I02B-T03b (I02B-R5, R36, R37, R40; I02B-C3 at the API, C5, C14 setting half, C30, C43, C52 flag): the
// location API. The handler is tried on its own (the approval's verdicts, the ticket, the limits), and one
// booted backend shows the routes, the stored source's scope and that no file content leaves.
// Synthetic data only; the folder is a real temporary one.
import { APPROVAL_REJECTION_CODES } from "@pki/connector-sdk";
import {
  LOCAL_APPROVAL_REJECTION_CODES,
  routes,
  type LocalFilesSettings,
  type LocalNormalizerPort,
} from "@pki/contracts";
import { NORMALIZER_VERSION } from "@pki/document-normalize";
import {
  createLocalFileIndex,
  insertLocation,
  newLocalId,
  registerConnectorInstance,
  type SqlDriver,
} from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { openCanonicalDb } from "./composition.ts";
import { inProcessNormalizer } from "./local-normalizer.test-support.ts";
import {
  createApprovalTickets,
  createLocalLocations,
  TICKET_TTL_MS,
} from "./local-locations.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "l".repeat(43);
const MARKER = "ZQ-MARKER-7731-never-leaves";

let root: string;
let data: string;
let docs: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-local-api-")));
  data = join(root, "data");
  docs = join(root, "docs");
  mkdirSync(docs);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const rowCount = (db: SqlDriver) =>
  Number(db.all("SELECT count(*) AS n FROM local_locations")[0]?.n);

/** The handler over a canonical database; the build kind and the sync are the test's to set. */
function handler(over: { buildKind?: "production" | "test" } = {}) {
  const db = openCanonicalDb(data);
  registerConnectorInstance(db, "local-files", "local-files");
  const approved = vi.fn();
  const tickets = createApprovalTickets();
  const locations = createLocalLocations({
    db,
    index: createLocalFileIndex(db),
    forbidden: [data],
    buildKind: over.buildKind ?? "test",
    tickets,
    onApproved: approved,
    normalizerUnavailable: () => false,
  });
  return { db, locations, tickets, approved };
}

describe("approval (I02B-R5, R37; I02B-C3 at the API, C43)", () => {
  it("a rejected approval stores nothing (M4): the same place twice, and a location whose disk is gone", async () => {
    const { db, locations, approved } = handler();
    try {
      const first = await locations.approve({ type: "folder", path: docs });
      expect(first).toMatchObject({ type: "folder", displayPath: docs, state: "active" });
      expect("id" in first && first.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(rowCount(db)).toBe(1);

      const again = await locations.approve({ type: "folder", path: docs });
      expect(again).toEqual({ error: "approval-rejected", code: "overlaps-location" });
      expect(rowCount(db)).toBe(1);
      expect(approved).toHaveBeenCalledTimes(1);

      // an approved location whose folder cannot be read now: refused, not approved
      insertLocation(db, {
        id: newLocalId(),
        type: "folder",
        displayPath: "/gone/x",
        realPath: join(root, "gone-disk", "x"),
        rootDev: "1",
        rootIno: "999999",
        createdAt: "2026-11-23T00:00:00.000Z",
      });
      const other = join(root, "other");
      mkdirSync(other);
      const unreachable = await locations.approve({ type: "folder", path: other });
      expect(unreachable).toEqual({ error: "approval-rejected", code: "location-unreachable" });
      expect(rowCount(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("outside a test build an approval without a one-time ticket is refused and stores nothing (M5); a ticket works once", async () => {
    const { db, locations, tickets } = handler({ buildKind: "production" });
    try {
      const typed = await locations.approve({ type: "folder", path: docs });
      expect(typed).toEqual({ error: "approval-rejected", code: "ticket-required" });
      const guessed = await locations.approve({ type: "folder", ticket: "t".repeat(32) });
      expect(guessed).toEqual({ error: "approval-rejected", code: "ticket-required" });
      expect(rowCount(db)).toBe(0);

      tickets.register({ ticket: "k".repeat(32), type: "folder", path: docs });
      const done = await locations.approve({ type: "folder", ticket: "k".repeat(32) });
      expect(done).toMatchObject({ displayPath: docs });
      expect(rowCount(db)).toBe(1);
      const replay = await locations.approve({ type: "folder", ticket: "k".repeat(32) });
      expect(replay).toEqual({ error: "approval-rejected", code: "ticket-required" });
      expect(rowCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("an expired ticket is refused (S4, FU-2)", () => {
    let at = 1_000;
    const tickets = createApprovalTickets({ now: () => at });
    tickets.register({ ticket: "e".repeat(32), type: "folder", path: docs });
    at += TICKET_TTL_MS + 1;
    expect(tickets.redeem("e".repeat(32), "folder")).toBeUndefined();
    tickets.register({ ticket: "f".repeat(32), type: "folder", path: docs });
    at += TICKET_TTL_MS - 1;
    expect(tickets.redeem("f".repeat(32), "folder")).toBe(docs);
  });

  it("the route's code list is the SDK's plus the ticket's", () => {
    expect([...LOCAL_APPROVAL_REJECTION_CODES].sort()).toEqual(
      [...APPROVAL_REJECTION_CODES, "ticket-required"].sort(),
    );
  });
});

describe("limits settings (I02B-R40, I02B-C14 setting half)", () => {
  it("lowering a walk limit below its value while the location holds entries is refused and nothing changes; raising is allowed (FU8)", async () => {
    const { db, locations } = handler();
    try {
      expect(locations.settings().walk.maxDepth).toBe(32);
      const made = await locations.approve({ type: "folder", path: docs });
      if (!("id" in made)) throw new Error("setup");
      // empty location: lowering cannot turn an entry into a delete
      expect(locations.writeSettings({ walk: { maxDepth: 16 } })).toMatchObject({
        walk: { maxDepth: 16 },
      });
      createLocalFileIndex(db).insertEntry(
        {
          externalId: newLocalId(),
          locationId: made.id,
          relativePath: "a/b.md",
          size: 1,
          mtimeNs: "1",
          contentHash: "h".repeat(64),
          fileNo: "1:2",
          revision: 1,
          normalizerVersion: NORMALIZER_VERSION,
          state: "present",
          pendingDelete: 0,
          skipReason: null,
          skippedAt: null,
          skipLimits: null,
        },
        [],
      );
      expect(locations.writeSettings({ walk: { maxDepth: 8 } })).toEqual({
        error: "limit-would-delete",
      });
      expect(locations.writeSettings({ walk: { maxRelativePathChars: 10 } })).toEqual({
        error: "limit-would-delete",
      });
      expect(locations.settings().walk).toMatchObject({ maxDepth: 16, maxRelativePathChars: 1024 });
      // raising, and a limit that cannot drop an entry, are allowed
      expect(locations.writeSettings({ walk: { maxDepth: 64 }, settleMs: 5 })).toMatchObject({
        walk: { maxDepth: 64 },
        settleMs: 5,
      });
    } finally {
      db.close();
    }
  });
});

// --- one booted backend ---------------------------------------------------------------------------

describe("the routes of a booted backend (I02B-R36)", () => {
  let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
  afterEach(async () => {
    await booted?.server.close();
    booted?.db.close();
    booted = undefined;
  });

  const start = async (normalizer: LocalNormalizerPort) => {
    const running = await bootBackend({
      dataDir: data,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [],
      localFiles: { normalizer },
    });
    booted = running;
    const h = { host: `127.0.0.1:${running.server.port}`, authorization: `Bearer ${TOKEN}` };
    const call = (path: string, method = "GET", body?: unknown) =>
      send(running.server.port, path, h, method, body);
    return { call, db: running.db };
  };

  it("approve, sync twice, read: the source has no claimed scope, a refused approval says why, and no content leaves in a body or a log (C5, C30)", async () => {
    const lines: string[] = [];
    for (const method of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, method).mockImplementation(
        (...a: unknown[]) => void lines.push(a.join(" ")),
      );
    }
    writeFileSync(join(docs, "note.md"), `# Title\n\n${MARKER}\n`);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(docs, "note.md"), old, old);
    const { call, db } = await start(inProcessNormalizer());
    const bodies: string[] = [];
    const seen = async (path: string, method = "GET", body?: unknown) => {
      const r = await call(path, method, body);
      bodies.push(JSON.stringify(r.body));
      return r;
    };

    expect((await seen(routes.setLocalFilesSettings.path, "POST", { settleMs: 1 })).status).toBe(
      200,
    );
    const bad = await seen(routes.setLocalFilesSettings.path, "POST", { settleMs: 0 });
    expect(bad.status).toBe(400);
    expect(((await seen(routes.localFilesSettings.path)).body as LocalFilesSettings).settleMs).toBe(
      1,
    );

    const approved = await seen(routes.approveLocalLocation.path, "POST", {
      type: "folder",
      path: docs,
    });
    expect(approved.status).toBe(200);
    const refused = await seen(routes.approveLocalLocation.path, "POST", {
      type: "folder",
      path: docs,
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ error: "approval-rejected", code: "overlaps-location" });

    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const synced = await seen(routes.syncConnector.path, "POST", { connectorId: "local-files" });
      expect(synced.status).toBe(200);
    }
    const sources = (await seen(routes.sources.path)).body as {
      sources: { connectorId: string; externalId: string }[];
    };
    const mine = sources.sources.filter((s) => s.connectorId === "local-files");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.externalId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(
      db.all(
        "SELECT access_scope, scope_claimed FROM sources WHERE connector_instance_id = 'local-files'",
      ),
    ).toEqual([{ access_scope: null, scope_claimed: 0 }]);

    const list = (await seen(routes.localLocations.path)).body as {
      locations: { displayPath: string; counts: { tracked: number } }[];
      normalizerUnavailable: boolean;
    };
    expect(list.locations).toHaveLength(1);
    expect(list.locations[0]).toMatchObject({ displayPath: docs, counts: { tracked: 1 } });
    expect(list.normalizerUnavailable).toBe(false);
    expect(bodies.join("\n")).not.toContain(MARKER);
    expect(lines.join("\n")).not.toContain(MARKER);
  });

  it("a broken normalizer host shows as normalizer-unavailable in the list (C52, API half)", async () => {
    const { call } = await start(inProcessNormalizer(true));
    const list = (await call(routes.localLocations.path)).body as {
      normalizerUnavailable: boolean;
    };
    expect(list.normalizerUnavailable).toBe(true);
  });
});
