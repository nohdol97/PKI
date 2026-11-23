// I02B-T04 T4 (I02B-R10, R49; C13 revoke half, C39, C40): the revocation of an approved location is the
// user's deletion of every source of it, in canonical transactions that commit with the ledger lines.
// One representative case per clause; the connector's world gives the real index and real sources.
import { defaultEntries } from "@pki/knowledge-engine";
import {
  attachLedger,
  insertLocation,
  LedgerLineUnwritableError,
  listLocations,
  newLocalId,
  openLedger,
  saveSourceRecord,
  type TombstoneLedger,
} from "@pki/storage";
import { memoryLedgerIo } from "@pki/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { storeUpserts, upserts, world, type World } from "./local-files-connector.test-support.ts";
import { tryLockInstance } from "./instance-lock.ts";
import { createLocalRevoke } from "./local-revoke.ts";

const worlds: World[] = [];
const afterAll: (() => void)[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
  for (const f of afterAll.splice(0)) f();
});

/** A world holding `n` stored sources in its location. */
async function seeded(n: number) {
  const w = world();
  worlds.push(w);
  for (let i = 0; i < n; i++) w.write(`f${i}.md`, `# f${i}\n\nbody of f${i}\n`);
  storeUpserts(w, await w.settle());
  return w;
}
const count = (w: World, sql: string, ...params: string[]) => Number(w.db.all(sql, params)[0]?.n);
const live = (w: World, id = w.locationId) =>
  count(
    w,
    "SELECT count(*) AS n FROM sources WHERE connector_instance_id = 'local-files' AND namespace = ? AND identity_hashed = 0",
    id,
  );
const entries = (w: World, id = w.locationId) =>
  count(w, "SELECT count(*) AS n FROM local_file_entries WHERE location_id = ?", id);
const rows = (w: World, id = w.locationId) => listLocations(w.db).filter((l) => l.id === id);
const tombstones = (w: World) =>
  count(w, "SELECT count(*) AS n FROM tombstones WHERE reason = 'user-deleted'");

function revoker(w: World, options: { max?: number; lockWaitMs?: number } = {}) {
  const steps: (() => unknown)[] = [];
  const revoke = createLocalRevoke({
    db: w.db,
    entries: defaultEntries,
    limits: () => ({ maxPerTransaction: options.max ?? 100, lockWaitMs: options.lockWaitMs ?? 20 }),
    cancelSync: () => undefined,
    schedule: (step) => void steps.push(step),
    now: () => new Date(w.clock.t).toISOString(),
  });
  const drain = async (max = Infinity) => {
    for (let i = 0; i < max && steps.length > 0; i++) await (steps.shift() as () => unknown)();
  };
  return { revoke, steps, drain };
}

/** A ledger over memory I/O, optionally refusing lines or locked. */
function ledgerOn(w: World) {
  const real: TombstoneLedger = openLedger({
    path: "/data/ledger.jsonl",
    key: new Uint8Array(32).fill(5),
    canonicalSeq: 0,
    hasData: false,
    io: memoryLedgerIo(),
  });
  const control = { refuse: false };
  const ledger: TombstoneLedger = {
    ...real,
    reserve(n, seq) {
      if (control.refuse) throw new LedgerLineUnwritableError();
      return real.reserve(n, seq);
    },
  };
  attachLedger(w.db, ledger);
  return { control, lock: () => real.lock() };
}

describe("C13 revoke", () => {
  it("every source of the location gets a user-deleted tombstone and its rows go; another location stays; a wrong count changes nothing", async () => {
    const w = await seeded(3);
    // another location with one source and one entry
    const other = newLocalId();
    insertLocation(w.db, {
      id: other,
      type: "folder",
      displayPath: "/o",
      realPath: "/o",
      rootDev: "1",
      rootIno: "2",
      createdAt: "2026-11-23T00:00:00.000Z",
    });
    saveSourceRecord(w.db, "local-files", {
      namespace: other,
      externalId: "o".repeat(22),
      title: "o",
      body: "o",
    });
    const { revoke } = revoker(w);

    expect(await revoke.revoke({ locationId: w.locationId, count: 2 })).toEqual({
      error: "count-mismatch",
    });
    expect([live(w), entries(w), rows(w).length]).toEqual([3, 3, 1]);

    expect(await revoke.revoke({ locationId: w.locationId, count: 3 })).toEqual({
      state: "revoked",
      revoked: 3,
    });
    expect([live(w), entries(w), rows(w).length, tombstones(w)]).toEqual([0, 0, 0, 3]);
    // only the other location's source keeps a version
    expect(count(w, "SELECT count(*) AS n FROM source_versions")).toBe(1);
    expect([live(w, other), rows(w, other).length]).toEqual([1, 1]);
    // the same folder approved again is a new location id: its sources are not blocked
    const again = saveSourceRecord(w.db, "local-files", {
      namespace: newLocalId(),
      externalId: "a".repeat(22),
      title: "t",
      body: "b",
    });
    expect(again.status).toBe("created");
  });
});

describe("C39 the ledger and the lock", () => {
  it("a locked or refusing ledger and a held instance lock answer an error and leave counts and state as they were", async () => {
    const w = await seeded(3);
    const ledger = ledgerOn(w);
    const { revoke } = revoker(w, { lockWaitMs: 30 });
    const before = () => [live(w), entries(w), rows(w)[0]?.state, tombstones(w)];
    const start = before();

    ledger.control.refuse = true;
    expect(await revoke.revoke({ locationId: w.locationId, count: 3 })).toEqual({
      error: "ledger-unwritable",
    });
    expect(before()).toEqual(start);
    ledger.control.refuse = false;

    const release = tryLockInstance(w.db, "local-files") as () => void;
    expect(await revoke.revoke({ locationId: w.locationId, count: 3 })).toEqual({
      error: "instance-busy",
    });
    release();
    expect(before()).toEqual(start);

    ledger.lock();
    expect(await revoke.revoke({ locationId: w.locationId, count: 3 })).toEqual({
      error: "ledger-degraded",
    });
    expect(before()).toEqual(start);
  });
});

describe("C40 batches", () => {
  it("max 3 of 9: revoking with 6 left, no edit gets in, no location row is ever missing while sources live, an interleaved source costs one more batch", async () => {
    const w = await seeded(9);
    const { revoke, steps, drain } = revoker(w, { max: 3 });
    expect(await revoke.revoke({ locationId: w.locationId, count: 9 })).toEqual({
      state: "revoking",
      remaining: 6,
    });
    expect(rows(w)[0]?.state).toBe("revoking");
    w.write("f0.md", "# f0\n\nbody of f0, edited\n");
    expect(upserts([...(await w.sync()), ...(await w.sync())])).toHaveLength(0);

    const invariant = () => expect(rows(w).length === 0 && live(w) > 0).toBe(false);
    await drain(1);
    invariant();
    expect(live(w)).toBe(3); // the next batch would be the last
    saveSourceRecord(w.db, "local-files", {
      namespace: w.locationId,
      externalId: "n".repeat(22),
      title: "n",
      body: "n",
    });
    await drain(1);
    invariant();
    expect([rows(w).length, live(w)]).toEqual([1, 1]); // the location row stays, one more batch
    await drain();
    expect([rows(w).length, live(w), entries(w), steps.length]).toEqual([0, 0, 0, 0]);
  });

  it("a refused batch is undone alone and the location stays revoking with its reason; the same call with the remaining count finishes it; a restart continues unaided", async () => {
    const w = await seeded(10);
    const ledger = ledgerOn(w);
    const { revoke, drain } = revoker(w, { max: 3 });
    await revoke.revoke({ locationId: w.locationId, count: 10 });
    await drain(1); // second batch done: 4 left
    ledger.control.refuse = true;
    await drain(); // the third is refused and rolled back
    expect(live(w)).toBe(4);
    expect(rows(w)[0]).toMatchObject({ state: "revoking", stateReason: "ledger-unwritable" });
    ledger.control.refuse = false;
    expect(await revoke.revoke({ locationId: w.locationId, count: 4 })).toEqual({
      state: "revoking",
      remaining: 1,
    });
    await drain();
    expect([rows(w).length, live(w), entries(w)]).toEqual([0, 0, 0]);

    // a restart: a new revoker over the same database picks up what was left revoking
    const w2 = await seeded(5);
    const first = revoker(w2, { max: 2 });
    await first.revoke.revoke({ locationId: w2.locationId, count: 5 });
    const second = revoker(w2, { max: 2 });
    second.revoke.resume();
    await second.drain();
    expect([rows(w2).length, live(w2), entries(w2)]).toEqual([0, 0, 0]);
  });
});
