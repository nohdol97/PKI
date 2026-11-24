// RDF-C1, RDF-C2: a start that is cut off between the ledger's changes and the folder halt (I02B-R34) still
// halts the folders at the next start, and still asks for the projection rebuild. Function-level: the
// "crash" is the start not going on to `driver.start`.
import { PROJECTION_REBUILD_KIND } from "@pki/storage";
import {
  LEDGER_FILE,
  insertLocation,
  listLocations,
  newLocalId,
  registerConnectorInstance,
  reopenLocation,
  saveSourceRecord,
  type LocalLocation,
  type SqlDriver,
} from "@pki/storage";
import { EmptyVectorIndex } from "@pki/storage/adapters";
import { userDelete } from "@pki/knowledge-engine";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_DB_FILE,
  openCanonicalDb,
  productEngine,
  productRegistry,
} from "./composition.ts";
import { needsRebuild, reapplyAtStart } from "./ledger-boot.ts";
import { createLocalFilesDriver } from "./local-files-driver.ts";

const AT = "2026-11-22T00:00:00.000Z";
const MARKER = "tombstone-ledger.halt-pending";

let dir: string;
const open: SqlDriver[] = [];
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-ledger-halt-"))));
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const opened = (): SqlDriver => {
  const db = openCanonicalDb(dir);
  open.push(db);
  return db;
};
const closeAll = () => {
  for (const db of open.splice(0)) db.close();
};
const registry = () =>
  productRegistry({ engine: productEngine(), vectorIndex: new EmptyVectorIndex() });
const markerRows = (db: SqlDriver) =>
  db.all("SELECT 1 FROM settings WHERE key = ?", [MARKER]).length;
const openRebuilds = (db: SqlDriver) =>
  db.all(
    `SELECT target FROM jobs WHERE kind = ? AND status NOT IN ('succeeded', 'superseded', 'cancelled', 'dead_letter')
      ORDER BY target`,
    [PROJECTION_REBUILD_KIND],
  ).length;
const addFolder = (db: SqlDriver): string => {
  registerConnectorInstance(db, "local-files", "local-files");
  const id = newLocalId();
  insertLocation(db, {
    id,
    type: "folder",
    displayPath: dir,
    realPath: dir,
    rootDev: "1",
    rootIno: "1",
    createdAt: AT,
  });
  return id;
};
const location = (db: SqlDriver, id: string) =>
  listLocations(db).find((l) => l.id === id) as LocalLocation;
const driverOver = (db: SqlDriver) => {
  const registered: number[] = [];
  const driver = createLocalFilesDriver({
    db,
    registerSync: () => void registered.push(1),
    revoke: { resume: () => undefined },
    watch: () => ({ close: () => undefined }),
    timers: { set: () => 0, clear: () => undefined },
    now: () => 0,
    limits: () => ({ quietMs: 2_000, maxWaitMs: 30_000 }),
  });
  return { driver, registered };
};
const seeded = (): SqlDriver => {
  const db = opened();
  registerConnectorInstance(db, "c1", "jsonl-import");
  saveSourceRecord(db, "c1", { namespace: "n", externalId: "chat", title: "t", body: "본문" });
  return db;
};

describe("RDF halt-pending marker", () => {
  it("RDF-C1: a start cut off after the re-apply still halts the folder at the next start and keeps the rebuild request", () => {
    // a database restored older than the ledger: one unapplied line
    const first = seeded();
    first.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    userDelete(first, { connectorInstanceId: "c1", namespace: "n", externalId: "chat" }, AT);
    closeAll();
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));

    const db = opened();
    const folder = addFolder(db);
    const one = reapplyAtStart(db, registry(), Date.parse(AT));
    expect(one.applied).toBe(1);
    // the start dies here: no driver.start, and the rebuild jobs it registered are not there
    db.run("DELETE FROM jobs WHERE kind = ?", [PROJECTION_REBUILD_KIND]);
    expect(openRebuilds(db)).toBe(0);

    const two = reapplyAtStart(db, registry(), Date.parse(AT));
    expect(two.applied).toBe(0);
    expect(openRebuilds(db)).toBe(2);

    const { driver, registered } = driverOver(db);
    driver.start(needsRebuild(two));
    expect(location(db, folder)).toMatchObject({ state: "paused", stateReason: "restored" });
    expect(registered).toEqual([]);
    expect(markerRows(db)).toBe(0);

    // the user turned the folder on again: the next start does not halt it
    expect(reopenLocation(db, folder)).toBe(true);
    driver.stop();
    const next = driverOver(db);
    next.driver.start(false);
    expect(location(db, folder).state).toBe("active");
    expect(next.registered).toEqual([1]);
    next.driver.stop();
  });

  it("RDF-C2: a ledger created beside a database with data and cut off before the halt still halts the folder; an empty new database leaves no marker", () => {
    const db = seeded();
    const folder = addFolder(db);
    closeAll();
    rmSync(join(dir, LEDGER_FILE)); // the ledger is gone
    // the start opens the database (the ledger is created) and dies before anything else
    opened();
    closeAll();

    const again = opened();
    const report = reapplyAtStart(again, registry(), Date.parse(AT));
    expect(report.missing).toBe(false);
    const { driver } = driverOver(again);
    driver.start(needsRebuild(report));
    expect(location(again, folder)).toMatchObject({ state: "paused", stateReason: "restored" });
    expect(markerRows(again)).toBe(0);
    driver.stop();
    closeAll();

    // an empty new database: the same sequence leaves no marker
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "pki-ledger-halt-"));
    const fresh = opened();
    const freshReport = reapplyAtStart(fresh, registry(), Date.parse(AT));
    expect(markerRows(fresh)).toBe(0);
    const freshDriver = driverOver(fresh);
    freshDriver.driver.start(needsRebuild(freshReport));
    expect(markerRows(fresh)).toBe(0);
    freshDriver.driver.stop();
  });
});
