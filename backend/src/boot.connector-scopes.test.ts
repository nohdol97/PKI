// I07-T02 on the real bootBackend (I07-R1, R2, R3, R4, R5; I07-C1, C4 ③, C5, C6 start): the instance scopes
// arrive as `SiteRegistration.connectorScopes` and as nothing else. An import of an instance the
// registration names leaves its value (sorted, no duplicates) in the canonical DB; no registration, or a
// value that is not usable, leaves NULL (unknown, the closed side) and never stops the start; two backends
// of one process hold their own values; the start logs exactly one state line with counts only.
// Synthetic values only: the markers below stand for scope values and instance ids that must not be logged.
import { routes } from "@pki/contracts";
import { registerConnectorInstance, setConfiguredScope, type SqlDriver } from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { openCanonicalDb } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { checkSiteRegistration, type SiteRegistration } from "./site-registration.ts";

const TOKEN = "k".repeat(43);
const MAIL = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8").split(
    "\n",
  )[0] as string,
) as Record<string, unknown>;
const SCOPE_MARKER = "synthetic-scope-marker-aaaa";
const ID_MARKER = "synthetic-instance-marker-bbbb";

let dirs: string[];
let started: Awaited<ReturnType<typeof bootBackend>>[];
let logged: string[];
beforeEach(() => {
  dirs = [];
  started = [];
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void logged.push(String(line)));
});
afterEach(async () => {
  for (const b of started) {
    await b.server.close();
    b.db.close();
  }
  vi.restoreAllMocks();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pki-boot-scopes-"));
  dirs.push(d);
  return d;
};

async function boot(site?: SiteRegistration, dataDir: string = freshDir()) {
  const booted = await bootBackend({
    dataDir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    ...(site ? { site } : {}),
  });
  started.push(booted);
  const { port } = booted.server;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    db: booted.db,
    importInto: (instanceId: string) =>
      send(port, routes.imports.path, headers, "POST", {
        instanceId,
        content: JSON.stringify({
          ...MAIL,
          external_id: `e-${instanceId}`,
          connector_instance_id: instanceId,
          access_scope: ["open"],
        }),
      }),
  };
}

const configuredOf = (db: SqlDriver, id: string) =>
  db.all("SELECT configured_scope FROM connector_instances WHERE id = ?", [id])[0]
    ?.configured_scope;

describe("C1: the value comes from the registration", () => {
  it("① an import of an instance the registration names leaves its sorted, de-duplicated scope in the canonical DB", async () => {
    const { db, importInto } = await boot({ connectorScopes: { "imp-one": ["z", "b", "z"] } });
    expect((await importInto("imp-one")).status).toBe(200);
    expect(configuredOf(db, "imp-one")).toBe('["b","z"]');
  });

  it("② a registration that carries none leaves NULL after the same import", async () => {
    const { db, importInto } = await boot({});
    expect((await importInto("imp-one")).status).toBe(200);
    expect(configuredOf(db, "imp-one")).toBeNull();
    const second = await boot(undefined);
    expect((await second.importInto("imp-one")).status).toBe(200);
    expect(configuredOf(second.db, "imp-one")).toBeNull();
  });

  it("③ two backends of one process, started from different registrations, each keep their own value (no process-wide value)", async () => {
    const a = await boot({ connectorScopes: { "imp-one": ["team-a"] } });
    const b = await boot({ connectorScopes: { "imp-one": ["team-b"] } });
    const c = await boot({});
    await a.importInto("imp-one");
    await b.importInto("imp-one");
    await c.importInto("imp-one");
    expect(configuredOf(a.db, "imp-one")).toBe('["team-a"]');
    expect(configuredOf(b.db, "imp-one")).toBe('["team-b"]');
    expect(configuredOf(c.db, "imp-one")).toBeNull();
  });
});

describe("C4 ③ and the closed side: what is not usable is unknown, never wider", () => {
  it("an import-registered instance gets the table's value before its first source is stored; an entry the table lacks stays NULL", async () => {
    const { db, importInto } = await boot({
      connectorScopes: { "imp-one": ["team"], "imp-bad": "team", "imp-null": null },
    });
    for (const id of ["imp-one", "imp-bad", "imp-null", "imp-unlisted"]) {
      expect((await importInto(id)).status, id).toBe(200);
    }
    expect(configuredOf(db, "imp-one")).toBe('["team"]');
    for (const id of ["imp-bad", "imp-null", "imp-unlisted"]) {
      expect(configuredOf(db, id), id).toBeNull();
    }
  });

  it.each([[["kept-old"]], [null], ["kept-old"], [7], [true]])(
    "a value that is not an object (%j), at a start where an older value is stored, clears it: unknown, and the start goes on",
    async (bad) => {
      const dir = freshDir();
      const earlier = openCanonicalDb(dir);
      registerConnectorInstance(earlier, "kept-old", "k");
      setConfiguredScope(earlier, "kept-old", ["old"]);
      earlier.close();
      const { db } = await boot({ connectorScopes: bad }, dir);
      expect(configuredOf(db, "kept-old")).toBeNull();
    },
  );

  it("two registration violations (a value that is not an object, an entry that is not well-formed) still let the start finish", async () => {
    for (const connectorScopes of [7, { a: "x", b: [1] }]) {
      const site: SiteRegistration = { connectorScopes };
      expect(checkSiteRegistration(site).length).toBeGreaterThan(0);
      const { db, importInto } = await boot(site);
      expect((await importInto("imp-one")).status).toBe(200);
      expect(configuredOf(db, "imp-one")).toBeNull();
    }
  });
});

describe("C5: one state line per start, counts only", () => {
  const scopeLines = () =>
    logged
      .filter((l) => l.includes("connector-scopes-"))
      .map((l) => JSON.parse(l) as { event: string; configured?: number; count?: number });

  it.each([
    ["no field", undefined, "connector-scopes-absent", 0],
    ["a value that is not an object", [SCOPE_MARKER], "connector-scopes-invalid", 0],
    [
      "an object with no entry that has a scope",
      { [ID_MARKER]: null },
      "connector-scopes-empty",
      0,
    ],
    ["an empty object", {}, "connector-scopes-empty", 0],
    [
      "an object with one or more scoped entries",
      { [ID_MARKER]: [SCOPE_MARKER], other: [SCOPE_MARKER] },
      "connector-scopes-bound",
      2,
    ],
  ])("%s: exactly the line %s with configured %s", async (_name, value, event, configured) => {
    await boot(value === undefined ? {} : { connectorScopes: value });
    expect(scopeLines()).toEqual([{ event, configured }]);
  });

  it("the public registration (none handed) logs absent", async () => {
    await boot(undefined);
    expect(scopeLines()).toEqual([{ event: "connector-scopes-absent", configured: 0 }]);
  });

  it("an entry that is not well-formed adds the rejected line with its count, after the state line", async () => {
    await boot({
      connectorScopes: { good: ["x"], text: "x", number: [1], blank: [""] },
    });
    expect(scopeLines()).toEqual([
      { event: "connector-scopes-bound", configured: 1 },
      { event: "connector-scopes-rejected", count: 3 },
    ]);
    const only = await boot({ connectorScopes: { text: "x" } });
    expect(only.db).toBeDefined();
    expect(scopeLines().slice(2)).toEqual([
      { event: "connector-scopes-empty", configured: 0 },
      { event: "connector-scopes-rejected", count: 1 },
    ]);
  });

  it("no scope value, instance id or file name is in any line of the whole start, whatever the state", async () => {
    const values = [
      { [ID_MARKER]: [SCOPE_MARKER] },
      { [ID_MARKER]: SCOPE_MARKER, [`${ID_MARKER}-b`]: [SCOPE_MARKER] },
      [ID_MARKER, SCOPE_MARKER],
      { [ID_MARKER]: null },
    ];
    for (const connectorScopes of values) {
      const { importInto } = await boot({ connectorScopes });
      await importInto(ID_MARKER);
    }
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(SCOPE_MARKER);
      expect(line).not.toContain(ID_MARKER);
      expect(line).not.toContain("connector-scopes.json");
    }
  });
});
