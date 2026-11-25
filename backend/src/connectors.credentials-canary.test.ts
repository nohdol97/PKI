// I06-C14 ①②③④⑤ (I06-R16 to R18): a made-up credential value sits in the store and a Connector leaks it on
// purpose (into error text, error name, `cause`, the health reason); the backend runs the paths that touch
// it, and then every place the product writes or answers is searched for the value in its three shapes
// (plain, base64, percent-encoded). T04 adds the change notice's API answer to the searched places (C14 ③). Nothing here is real.
import {
  CONNECTOR_SDK_VERSION,
  ConnectorCredentialError,
  routes,
  type Connector,
  type ConnectorContext,
  type SecretRead,
} from "@pki/contracts";
import { migrate, registerJob } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { send, memoryDbTemplate } from "@pki/testkit";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { connectorCredentialName } from "./connector-credentials.ts";
import { CONNECTOR_SYNC_KIND } from "./connector-sync-job.ts";
import { createConnectorManager, type ConnectorFactory } from "./connectors.ts";
import { runSiteCheck, type SiteCheckIo } from "./site-check-main.ts";
import type { SiteRegistration } from "./site-registration.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const TOKEN = "u".repeat(43);
/** The value the store holds; the code-shaped one passes the product log's field filter, so a leak into a field shows (B3). */
const PLAIN_CANARY = "synthetic canary/token+0001";
const CODE_CANARY = "synthCanaryToken_0001";
let CANARY = PLAIN_CANARY;
const PLANTED = "synthetic planted/marker+0002";
const shapes = (value: string): string[] => [
  value,
  Buffer.from(value).toString("base64"),
  encodeURIComponent(value),
];

let dir: string;
let logLines: string[];
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  CANARY = PLAIN_CANARY;
  dir = mkdtempSync(join(tmpdir(), "pki-canary-"));
  logLines = [];
  vi.spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void logLines.push(a.map(String).join(" ")),
  );
  vi.spyOn(console, "log").mockImplementation(
    (...a: unknown[]) => void logLines.push(a.map(String).join(" ")),
  );
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk) => (logLines.push(String(chunk)), true),
  );
  vi.spyOn(process.stderr, "write").mockImplementation(
    (chunk) => (logLines.push(String(chunk)), true),
  );
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const KIND = "fork";
const name = (id: string) => connectorCredentialName(KIND, id, "token");

/** What the Connector of an instance does, by its config's `mode`; every mode leaks the value where it can. */
function leaking(body: string): ConnectorFactory {
  return () => {
    let token = "";
    let mode = "ok";
    const leak = () => Object.assign(new Error(token), { name: token, cause: new Error(token) });
    return {
      manifest: {
        type: KIND,
        schemaVersion: CONNECTOR_SDK_VERSION,
        capabilities: {
          incremental: true,
          deletes: true,
          accessScope: false,
          fullRescan: true,
          deletionsOnRescan: false,
        },
      },
      initialize: async (config: unknown, context?: ConnectorContext) => {
        mode = (config as { mode?: string } | null)?.mode ?? "ok";
        token = await (context as ConnectorContext).credentials.read("token");
        if (mode === "init-leak") throw leak();
        if (mode === "init-refused")
          throw Object.assign(new ConnectorCredentialError(), {
            message: token,
            cause: new Error(token),
          });
      },
      healthCheck: async () => ({ state: "unavailable" as const, reason: token }),
      getChanges: async () => {
        if (mode === "sync-refused")
          throw Object.assign(new ConnectorCredentialError(), {
            message: token,
            cause: new Error(token),
          });
        if (mode === "sync-failed") throw leak();
        return {
          changes: [
            {
              kind: "upsert" as const,
              record: {
                namespace: "",
                externalId: "r1",
                revision: 1,
                schemaVersion: 2 as const,
                title: "t",
                body,
              },
            },
          ],
          nextCursor: "1",
          hasMore: false,
        };
      },
      getDocument: async () => null,
    } as unknown as Connector;
  };
}

const store = (values: Record<string, string>) => ({
  read: async (n: string): Promise<SecretRead> =>
    values[n] === undefined ? { state: "missing" } : { state: "present", value: values[n] },
  has: async (n: string) => (values[n] === undefined ? ("missing" as const) : ("present" as const)),
  deleteOthers: async () => "done" as const,
});

const instances = ["ok", "sync-refused", "sync-failed", "init-leak", "init-refused", "missing"].map(
  (mode) => ({
    id: mode,
    kind: KIND,
    config: { mode },
    credentials: ["token"],
  }),
);
const registration = (body: string): SiteRegistration => ({
  connectorKinds: { [KIND]: leaking(body) },
  connectorInstances: instances,
});
const secrets = () =>
  store(
    Object.fromEntries(
      instances.filter((i) => i.id !== "missing").map((i) => [name(i.id), CANARY]),
    ),
  );

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
};

/** Every byte under `root`, as text one can search (the DB, its journal files, the ledger). */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isFile() ? [readFileSync(path).toString("latin1")] : [];
  });
}

/** What `exercise` runs: the registration, the store, and the instances that sync as a job (I06S-C6 adds a scene). */
interface Scene {
  site: SiteRegistration;
  store: ReturnType<typeof store> & { write?: (name: string, value: string) => Promise<"done"> };
  ids: string[];
  jobIds: string[];
  kinds: string[];
}

/** Runs every path that touches a credential and returns the texts the product wrote or answered. */
async function exercise(
  body: string,
  deleteSource = true,
  scene: Scene = {
    site: registration(body),
    store: secrets(),
    ids: instances.map((i) => i.id),
    jobIds: ["sync-refused", "sync-failed", "missing", "ok"],
    kinds: [KIND],
  },
): Promise<{ answers: string[]; checkOutput: string }> {
  booted = await bootBackend({
    dataDir: join(dir, "data"),
    token: TOKEN,
    allowedOrigins: [],
    secrets: scene.store,
    providers: [],
    site: scene.site,
  });
  const port = booted.server.port;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  const answers: string[] = [];
  const call = async (path: string, method = "GET", payload?: unknown) => {
    const res = await send(port, path, headers, method, payload);
    answers.push(JSON.stringify(res.body));
    return res;
  };
  await call(routes.connectors.path);
  for (const id of scene.ids) await call(routes.syncConnector.path, "POST", { connectorId: id });
  // the change notice of every instance, whatever it leaks (C14 ③): each answer is searched with the rest
  for (const id of scene.ids)
    await call(routes.credentialsChanged.path, "POST", { connectorId: id });
  // and the hourly recheck of every instance (those that are not ready make a new object): C14 runs both before the sweep
  for (const id of scene.ids) await booted.connectors.recheck(id);
  // scheduled syncs: the refused, the failed and the one with no value are held or given up with a code
  for (const id of scene.jobIds) {
    registerJob(booted.db, { kind: CONNECTOR_SYNC_KIND, target: id });
  }
  await booted.runner.wake();
  await flush();
  if (deleteSource) {
    await call(routes.deleteSource.path, "POST", {
      connectorId: "ok",
      namespace: "",
      externalId: "r1",
    });
  }
  for (const route of [
    routes.connectors,
    routes.sources,
    routes.tombstones,
    routes.activity,
    routes.jobs,
    routes.status,
    routes.settings,
  ]) {
    await call(route.path);
  }
  const out: string[] = [];
  const io: SiteCheckIo = {
    stdout: (l) => out.push(l),
    stderr: (l) => out.push(l),
    exitCode: () => undefined,
  };
  await runSiteCheck(scene.site, scene.kinds, io);
  booted.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  return { answers, checkOutput: out.join("\n") };
}

describe("connectors.credentials-canary (I06-C14)", () => {
  it("①②③④ the value, in its three shapes, is in no data file, no log or stream, no API answer and no site-check line", async () => {
    const { answers, checkOutput } = await exercise("synthetic body of the record");
    const stored = filesUnder(join(dir, "data"));
    expect(stored.length).toBeGreaterThan(0);
    for (const shape of shapes(CANARY)) {
      expect(stored.filter((text) => text.includes(shape))).toEqual([]); // ① the data folder
      expect(logLines.filter((line) => line.includes(shape))).toEqual([]); // ② logs and streams
      expect(answers.filter((text) => text.includes(shape))).toEqual([]); // ③ API answers
      expect(checkOutput).not.toContain(shape); // ④ site-check
    }
    expect(checkOutput).toBe(`${KIND}: ok (credential-required)`);
  });

  it("B3 with a code-shaped value, which the log's field filter lets through, the same places are clean", async () => {
    CANARY = CODE_CANARY;
    const { answers, checkOutput } = await exercise("synthetic body of the record");
    const stored = filesUnder(join(dir, "data"));
    expect(stored.filter((text) => text.includes(CODE_CANARY))).toEqual([]);
    expect(logLines.filter((line) => line.includes(CODE_CANARY))).toEqual([]);
    expect(answers.filter((text) => text.includes(CODE_CANARY))).toEqual([]);
    expect(checkOutput).not.toContain(CODE_CANARY);
  });

  it("the paths ran: the refused sync stopped credential-unusable, the failed one connector-failed, and the held jobs say their reasons", async () => {
    const { answers } = await exercise("synthetic body of the record");
    const text = answers.join("\n");
    expect(text).toContain('"stopped":"credential-unusable"');
    expect(text).toContain('"stopped":"connector-failed"');
    expect(text).toContain("credential-missing");
    expect(text).toContain("credential-rejected");
  });

  it("③ the change notice answered for every instance (rebuilt, refused, leaking), and each answer says what became of the rebuild", async () => {
    const { answers } = await exercise("synthetic body of the record");
    const notices = answers.filter((text) => text.includes('"rebuild":'));
    expect(notices).toHaveLength(instances.length);
    expect(notices.join("\n")).toContain('"rebuild":"done"');
    for (const shape of shapes(CANARY)) {
      expect(notices.filter((text) => text.includes(shape))).toEqual([]);
    }
  });

  it("⑤ the same search finds a marker that really is in a record's body (it does search)", async () => {
    await exercise(`a record that carries ${PLANTED} in its body`, false);
    const stored = filesUnder(join(dir, "data"));
    expect(
      shapes(PLANTED).filter((shape) => stored.some((text) => text.includes(shape))).length,
    ).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain(PLANTED);
  });

  it("a change notice's rebuild and a recheck leave the value out of the summaries and the log, however the Connector leaks it", async () => {
    const store1 = secrets();
    const db = freshDb();
    const manager = await createConnectorManager(
      db,
      instances.filter((i) => i.id !== "missing"),
      { [KIND]: leaking("synthetic body") },
      { secrets: store1 },
    );
    for (const { id } of instances) {
      await manager.rebuild(id);
      await manager.recheck(id);
    }
    const seen = JSON.stringify(manager.list()) + logLines.join("\n");
    db.close();
    for (const shape of shapes(CANARY)) expect(seen).not.toContain(shape);
  });
});

// I06S-C6 (I06S-R14): a Connector that writes a rotated session value through `write` while it syncs, and
// leaks it where it can; the value (and the first session value) is in none of the places the product writes
// or answers, in any of its three shapes. The store is a memory double with a write; nothing here is real.
describe("connectors.credentials-canary: the write path (I06S-C6)", () => {
  const SESSION_KIND = "fork-session";
  const FIRST = "synthetic first session/+0003";
  const ROTATED = "synthetic rotated session/+0004";
  const sessionName = (id: string) => connectorCredentialName(SESSION_KIND, id, "session");

  /** Reads the session, writes the rotated value before its request returns, and (by mode) leaks it. */
  function rotating(body: string): ConnectorFactory {
    return () => {
      let mode = "ok";
      let context: ConnectorContext | undefined;
      const leak = (value: string) =>
        Object.assign(new ConnectorCredentialError(), { message: value, cause: new Error(value) });
      return {
        manifest: {
          type: SESSION_KIND,
          schemaVersion: CONNECTOR_SDK_VERSION,
          capabilities: {
            incremental: true,
            deletes: true,
            accessScope: false,
            fullRescan: true,
            deletionsOnRescan: false,
          },
        },
        initialize: async (config: unknown, given?: ConnectorContext) => {
          mode = (config as { mode?: string } | null)?.mode ?? "ok";
          context = given;
          await (context as ConnectorContext).credentials.read("session");
        },
        healthCheck: async () => ({ state: "unavailable" as const, reason: "down" }),
        getChanges: async () => {
          await (context as ConnectorContext).credentials.write?.("session", ROTATED);
          const written = await (context as ConnectorContext).credentials.read("session");
          if (mode === "leak") throw leak(written);
          return {
            changes: [
              {
                kind: "upsert" as const,
                record: {
                  namespace: "",
                  externalId: "r1",
                  revision: 1,
                  schemaVersion: 2 as const,
                  title: "t",
                  body,
                },
              },
            ],
            nextCursor: "1",
            hasMore: false,
          };
        },
        getDocument: async () => null,
      } as unknown as Connector;
    };
  }

  const login = {
    slot: "session",
    startUrl: "https://idp.example.test/login",
    doneUrlPrefix: "https://app.example.test/home",
    cookies: ["sid"],
  };
  const ids = ["ok", "leak"];
  const scene = (body: string): Scene => ({
    site: {
      connectorKinds: { [SESSION_KIND]: rotating(body) },
      connectorInstances: ids.map((id) => ({
        id,
        kind: SESSION_KIND,
        config: { mode: id },
        credentials: ["session"],
        login,
      })),
    },
    store: (() => {
      const values = Object.fromEntries(ids.map((id) => [sessionName(id), FIRST]));
      return {
        ...store(values),
        write: async (n: string, v: string) => ((values[n] = v), "done" as const),
      };
    })(),
    ids,
    jobIds: ids,
    kinds: [SESSION_KIND],
  });

  it("the written value and the first session value, in three shapes, are in no data file, log or stream, API answer or site-check line", async () => {
    const { answers, checkOutput } = await exercise(
      "synthetic body of the record",
      true,
      scene("synthetic body of the record"),
    );
    const stored = filesUnder(join(dir, "data"));
    expect(stored.length).toBeGreaterThan(0);
    for (const value of [ROTATED, FIRST]) {
      for (const shape of shapes(value)) {
        expect(stored.filter((text) => text.includes(shape))).toEqual([]);
        expect(logLines.filter((line) => line.includes(shape))).toEqual([]);
        expect(answers.filter((text) => text.includes(shape))).toEqual([]);
        expect(checkOutput).not.toContain(shape);
      }
    }
  });

  it("the paths ran: the write happened (the store holds the rotated value) and the leaking sync stopped credential-unusable", async () => {
    const live = scene("synthetic body of the record");
    const { answers } = await exercise("synthetic body of the record", false, live);
    const values = await Promise.all(ids.map((id) => live.store.read(sessionName(id))));
    expect(values).toEqual([
      { state: "present", value: ROTATED },
      { state: "present", value: ROTATED },
    ]);
    const text = answers.join("\n");
    expect(text).toContain('"stopped":"credential-unusable"');
  });

  it("the same search finds the rotated value when it really is in a record's body (it does search)", async () => {
    await exercise("x", false, scene(`a record that carries ${ROTATED} in its body`));
    const stored = filesUnder(join(dir, "data"));
    expect(
      shapes(ROTATED).filter((shape) => stored.some((text) => text.includes(shape))).length,
    ).toBeGreaterThan(0);
  });
});
