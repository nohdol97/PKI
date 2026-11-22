// I05-T03 on the real bootBackend (I05-R1, R8, R9, R12; I05-C7, C10 ③ ④ ⑤): a registration merges onto the
// base set at the start; four violations leave their item out and are counted in the log;
// the unknown kind is marked unavailable; the two reserved ones stop the start with the one fixed
// reason, before the canonical DB or the ledger is touched. The reserved names are walked from the
// public-kinds module, never typed here.
import { routes, CONNECTOR_SDK_VERSION, type Connector } from "@pki/contracts";
import { JSONL_IMPORT_KIND } from "@pki/connector-sdk";
import { userDelete } from "@pki/knowledge-engine";
import {
  LEDGER_FILE,
  readLedgerSeq,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { send } from "@pki/testkit";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_CONNECTOR_KINDS } from "./adapters/site-connectors.ts";
import { bootBackend } from "./boot.ts";
import { CANONICAL_DB_FILE, fixtureConnectors, openCanonicalDb } from "./composition.ts";
import type { ConnectorFactory } from "./connectors.ts";
import { readLedgerHistory } from "./ledger-history.ts";
import { PUBLIC_CONNECTOR_KINDS } from "./public-kinds.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { SiteRegistrationInvalidError, type SiteRegistration } from "./site-registration.ts";
import { startFailureLine, startFailureReport } from "./start-failure.ts";

const TOKEN = "u".repeat(43);
const FIXTURE_FILE = resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl");
const AT = "2026-11-22T00:00:00.000Z";
const MARKER = "marker-text-that-must-not-leak";

let dir: string;
let lines: string[];
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-site-"));
  lines = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const connectorOf = (type: string): Connector => ({
  manifest: {
    type,
    schemaVersion: CONNECTOR_SDK_VERSION,
    capabilities: {
      incremental: true,
      deletes: true,
      accessScope: false,
      fullRescan: true,
      deletionsOnRescan: false,
    },
  },
  initialize: async () => {},
  healthCheck: async () => ({ state: "ok" }),
  getChanges: async () => ({
    changes: [
      {
        kind: "upsert" as const,
        record: {
          namespace: "",
          externalId: "r0",
          revision: 1,
          schemaVersion: 2 as const,
          title: "t",
          body: "synthetic body",
        },
      },
    ],
    nextCursor: "1",
    hasMore: false,
  }),
  getDocument: async () => null,
});
const kindOf =
  (name: string): ConnectorFactory =>
  () =>
    connectorOf(name);
const instance = (id: string, kind: string) => ({ id, kind, config: {} });

const options = (site?: SiteRegistration, dataDir = dir) => ({
  dataDir,
  token: TOKEN,
  allowedOrigins: [],
  secrets: NO_SECRET_STORE,
  providers: [],
  ...(site ? { site } : {}),
});
const boot = async (site?: SiteRegistration, base?: ReturnType<typeof fixtureConnectors>) =>
  (booted = await bootBackend({ ...options(site), ...(base ? { connectors: base } : {}) }));
const api = () => {
  const port = booted?.server.port as number;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    list: async () =>
      (
        (await send(port, routes.connectors.path, headers)).body as {
          connectors: Array<{ id: string; kind: string; state: string }>;
        }
      ).connectors,
    sync: (connectorId: string) =>
      send(port, routes.syncConnector.path, headers, "POST", { connectorId }),
  };
};
const events = (name: string) =>
  lines.flatMap((l) => {
    try {
      const parsed = JSON.parse(l) as { event?: string };
      return parsed.event === name ? [parsed] : [];
    } catch {
      return [];
    }
  });

describe("boot.site-registration: the registration is merged onto the base set (I05-R1, C7 ④)", () => {
  it("a registered kind and its instance are listed ready and sync, next to the product's own", async () => {
    await boot({
      connectorKinds: { fork: kindOf("fork") },
      connectorInstances: [instance("fork-1", "fork")],
    });
    const listed = await api().list();
    expect(listed).toEqual(
      expect.arrayContaining([
        { id: "fork-1", kind: "fork", state: "ready" },
        { id: "site-mail", kind: "site-mail", state: "not-implemented" },
      ]),
    );
    expect((await api().sync("fork-1")).body).toMatchObject({ connectorId: "fork-1", created: 1 });
  });

  it("without a registration the list is the product's, as before", async () => {
    await boot();
    expect((await api().list()).map((c) => c.id).sort()).toEqual(
      SITE_CONNECTOR_KINDS.slice().sort(),
    );
  });

  it("a placeholder name registered replaces that kind: the fork's instance is ready, the placeholder instance gone", async () => {
    await boot({
      connectorKinds: { "site-mail": kindOf("site-mail") },
      connectorInstances: [instance("mail-1", "site-mail")],
    });
    const listed = await api().list();
    expect(listed.find((c) => c.id === "mail-1")).toMatchObject({ state: "ready" });
    expect(listed.find((c) => c.id === "site-mail")).toBeUndefined();
    expect(listed.find((c) => c.id === "site-wiki")).toMatchObject({ state: "not-implemented" });
  });

  it("④ over a base set a caller passes (fixtureConnectors) the registration is merged on top, and test-fixtures stays the base's", async () => {
    await boot(
      {
        connectorKinds: { fork: kindOf("fork") },
        connectorInstances: [instance("fork-1", "fork")],
      },
      fixtureConnectors(FIXTURE_FILE),
    );
    const listed = await api().list();
    expect(listed.map((c) => c.id)).toEqual(
      expect.arrayContaining(["fixtures", "fork-1", "site-mail"]),
    );
    expect(listed.find((c) => c.id === "fixtures")).toMatchObject({
      kind: "test-fixtures",
      state: "ready",
    });
  });
});

describe("boot.registration-rejected: four violations leave their item out and are counted once (I05-C7 ①)", () => {
  const publicKind = PUBLIC_CONNECTOR_KINDS[0] as string;
  const cases: Array<[string, SiteRegistration, string, string]> = [
    ["kind-name-invalid", { connectorKinds: { Bad: kindOf("Bad") } }, "Bad", "kinds"],
    [
      "kind-reserved",
      { connectorKinds: { [publicKind]: kindOf(publicKind) } },
      publicKind,
      "kinds",
    ],
    [
      "instance-id-invalid",
      { connectorKinds: { fork: kindOf("fork") }, connectorInstances: [instance("", "fork")] },
      "",
      "instances",
    ],
    [
      "instance-id-duplicate",
      {
        connectorKinds: { fork: kindOf("fork") },
        connectorInstances: [instance("dup", "fork"), instance("dup", "fork")],
      },
      "dup",
      "instances",
    ],
  ];

  it.each(cases)(
    "%s: the start ends and one rejected line with the code and the count",
    async (code, site, _name, what) => {
      await boot(site);
      expect(events("site-registration-rejected")).toEqual([
        { event: "site-registration-rejected", code, count: 1 },
      ]);
      expect(events("site-registration-invalid")).toEqual([]);
      const listed = await api().list();
      if (what === "kinds") {
        expect(listed.map((c) => c.kind).sort()).toEqual(SITE_CONNECTOR_KINDS.slice().sort());
      } else {
        expect(listed.filter((c) => c.kind === "fork").length).toBe(
          code === "instance-id-duplicate" ? 1 : 0,
        );
      }
    },
  );

  it("counts every occurrence of a code and writes one line per code", async () => {
    await boot({
      connectorKinds: { A: kindOf("A"), B: kindOf("B"), fork: kindOf("fork") },
      connectorInstances: [instance("", "fork"), instance("x", "fork"), instance("x", "fork")],
    });
    expect(events("site-registration-rejected")).toEqual([
      { event: "site-registration-rejected", code: "kind-name-invalid", count: 2 },
      { event: "site-registration-rejected", code: "instance-id-invalid", count: 1 },
      { event: "site-registration-rejected", code: "instance-id-duplicate", count: 1 },
    ]);
  });

  it("② an instance of a kind that is nowhere is unavailable, with connector-kind-unknown and no rejected line", async () => {
    await boot({
      connectorKinds: { fork: kindOf("fork") },
      connectorInstances: [instance("lost", "nowhere"), instance("fork-1", "fork")],
    });
    expect(events("connector-kind-unknown")).toEqual([
      { event: "connector-kind-unknown", id: "lost" },
    ]);
    expect(events("site-registration-rejected")).toEqual([]);
    const listed = await api().list();
    expect(listed.find((c) => c.id === "lost")).toMatchObject({ state: "unavailable" });
    expect(listed.find((c) => c.id === "fork-1")).toMatchObject({ state: "ready" });
  });
});

describe("boot.registration-invalid: the two reserved violations stop the start (I05-C7 ③)", () => {
  const reservedKinds = [...PUBLIC_CONNECTOR_KINDS, ...SITE_CONNECTOR_KINDS];
  const publicIds = [
    ...fixtureConnectors("/synthetic/f.jsonl").instances.map((i) => i.id),
    ...SITE_CONNECTOR_KINDS,
  ];

  async function refused(site: SiteRegistration, dataDir = join(dir, "never-made")) {
    const listen = vi.spyOn(http.Server.prototype, "listen");
    const error: unknown = await bootBackend(options(site, dataDir)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(listen).not.toHaveBeenCalled();
    expect(existsSync(dataDir)).toBe(false);
    return error;
  }

  it.each(reservedKinds)(
    "an instance of the kind %s fails the start with the fixed reason",
    async (kind) => {
      const error = await refused({
        connectorKinds: { fork: kindOf("fork") },
        connectorInstances: [instance(`mine-${MARKER}`, kind)],
      });
      expect(error).toBeInstanceOf(SiteRegistrationInvalidError);
      expect(startFailureReport(error)).toEqual({
        type: "failed",
        reason: "site-registration-invalid",
      });
      expect(startFailureLine(error)).toBe(
        "backend start failed: site-registration-invalid instance-kind-reserved=1",
      );
      expect(lines.join("\n")).not.toContain(MARKER);
      expect(startFailureLine(error)).not.toContain(MARKER);
      expect(events("site-registration-invalid")).toEqual([
        { event: "site-registration-invalid", code: "instance-kind-reserved", count: 1 },
      ]);
    },
  );

  it.each(publicIds)(
    "an instance with the public id %s fails the start with the fixed reason",
    async (id) => {
      const error = await refused({
        connectorKinds: { fork: kindOf(`fork`) },
        connectorInstances: [instance(id, "fork")],
      });
      expect(startFailureReport(error)).toEqual({
        type: "failed",
        reason: "site-registration-invalid",
      });
      expect(startFailureLine(error)).toBe(
        "backend start failed: site-registration-invalid instance-id-reserved=1",
      );
      expect(events("site-registration-invalid")).toEqual([
        { event: "site-registration-invalid", code: "instance-id-reserved", count: 1 },
      ]);
    },
  );

  it("a registration that names a public kind and also makes an instance of it does not start (the kind is refused, the instance is reserved)", async () => {
    const name = PUBLIC_CONNECTOR_KINDS[0] as string;
    const error = await refused({
      connectorKinds: { [name]: kindOf(name) },
      connectorInstances: [instance("mine", name)],
    });
    expect(startFailureReport(error)).toEqual({
      type: "failed",
      reason: "site-registration-invalid",
    });
  });

  it("④ the test kind's instance over the fixtures base stops the start the same way", async () => {
    const listen = vi.spyOn(http.Server.prototype, "listen");
    const never = join(dir, "never-made");
    const error: unknown = await bootBackend({
      ...options(
        {
          connectorKinds: { fork: kindOf("fork") },
          connectorInstances: [instance("mine", "test-fixtures")],
        },
        never,
      ),
      connectors: fixtureConnectors(FIXTURE_FILE),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(startFailureReport(error)).toEqual({
      type: "failed",
      reason: "site-registration-invalid",
    });
    expect(listen).not.toHaveBeenCalled();
    expect(existsSync(never)).toBe(false);
  });

  it("counts both reserved codes in the one line, and nothing else of the registration is in it", async () => {
    const error = await refused({
      connectorKinds: { fork: kindOf("fork") },
      connectorInstances: [
        instance("fixtures", "fork"),
        instance("a", PUBLIC_CONNECTOR_KINDS[0] as string),
        instance("b", PUBLIC_CONNECTOR_KINDS[0] as string),
      ],
    });
    expect(startFailureLine(error)).toBe(
      "backend start failed: site-registration-invalid instance-kind-reserved=2 instance-id-reserved=1",
    );
  });

  it("a drop-item violation next to a stopping one does not hide the stop", async () => {
    const error = await refused({
      connectorKinds: { Bad: kindOf("Bad"), fork: kindOf("fork") },
      connectorInstances: [instance("fixtures", "fork")],
    });
    expect(startFailureReport(error)).toEqual({
      type: "failed",
      reason: "site-registration-invalid",
    });
  });
});

describe("boot.site-registration-ledger: the ledger's re-apply knows the merged kinds (I05-R12, C10 ③ ④ ⑤)", () => {
  const identity = { connectorInstanceId: "fork-1", namespace: "n", externalId: "doc" };

  /** A backup taken before the instance existed, a deletion of its source afterwards, then the backup restored. */
  function restored(): SqlDriver {
    const db = openCanonicalDb(dir);
    db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    registerConnectorInstance(db, "fork-1", "fork-kind");
    saveSourceRecord(db, "fork-1", {
      namespace: "n",
      externalId: "doc",
      title: "t",
      body: "b 본문",
    });
    userDelete(db, identity, AT);
    db.close();
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));
    return openCanonicalDb(dir);
  }
  const tombstones = (db: SqlDriver) => db.all("SELECT count(*) AS n FROM tombstones")[0]?.n;

  it("③ the registered kind is known: the line is applied, the instance is bound to it, nothing is left unapplied", async () => {
    restored().close();
    await boot({ connectorKinds: { "fork-kind": kindOf("fork-kind") } });
    const { db } = booted as NonNullable<typeof booted>;
    expect(tombstones(db)).toBe(1);
    expect(db.all("SELECT kind FROM connector_instances WHERE id = 'fork-1'")).toEqual([
      { kind: "fork-kind" },
    ]);
    expect(readLedgerHistory(db).unrecoverable.total).toBe(0);
    expect(readLedgerHistory(db).reapplied.total).toBe(1);
  });

  it("④ the empty registration does not know it: no instance is made, the unapplied count is 1", async () => {
    restored().close();
    await boot();
    const { db } = booted as NonNullable<typeof booted>;
    expect(tombstones(db)).toBe(0);
    expect(db.all("SELECT id FROM connector_instances WHERE id = 'fork-1'")).toEqual([]);
    expect(readLedgerHistory(db).unrecoverable.total).toBe(1);
  });

  it("a public kind the registration tried to register is not known either: a refused name does not bind an instance", async () => {
    const name = PUBLIC_CONNECTOR_KINDS.find((k) => k !== JSONL_IMPORT_KIND) as string;
    const db = openCanonicalDb(dir);
    db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    registerConnectorInstance(db, "fork-1", name);
    saveSourceRecord(db, "fork-1", {
      namespace: "n",
      externalId: "doc",
      title: "t",
      body: "b 본문",
    });
    userDelete(db, identity, AT);
    db.close();
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));
    await boot({ connectorKinds: { [name]: kindOf(name) } });
    const { db: after } = booted as NonNullable<typeof booted>;
    expect(after.all("SELECT id FROM connector_instances WHERE id = 'fork-1'")).toEqual([]);
    expect(readLedgerHistory(after).unrecoverable.total).toBe(1);
  });

  it("⑤ a registration that stops the start leaves the database and the ledger as they were", async () => {
    restored().close();
    const dbFile = join(dir, CANONICAL_DB_FILE);
    const ledgerFile = join(dir, LEDGER_FILE);
    const before = { db: readFileSync(dbFile), ledger: readFileSync(ledgerFile) };
    const error: unknown = await bootBackend(
      options({
        connectorKinds: { "fork-kind": kindOf("fork-kind") },
        connectorInstances: [instance("fixtures", "fork-kind")],
      }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SiteRegistrationInvalidError);
    expect(readFileSync(dbFile).equals(before.db)).toBe(true);
    expect(readFileSync(ledgerFile).equals(before.ledger)).toBe(true);
    const raw = openCanonicalDb(dir);
    expect(readLedgerSeq(raw)).toBe(0);
    expect(tombstones(raw)).toBe(0);
    raw.close();
  });
});
