// I01-C2 `scope.claimed-grade` (I01-R15), the instance's configured scope: read from
// `site/config/connector-scopes.json`, copied into `connector_instances.configured_scope`.
// Missing or invalid input is unknown (null) and never a wider scope.
import {
  migrate,
  readSourceVersion,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyConfiguredScope,
  applyConfiguredScopes,
  CONNECTOR_SCOPES,
  CONNECTOR_SCOPES_FILE,
  loadConnectorScopes,
  parseConnectorScopes,
} from "./connector-scopes.ts";

describe("the file's content", () => {
  it("maps an instance id to a normalized scope, or to null", () => {
    const { scopes, rejected } = parseConnectorScopes(
      JSON.stringify({ a: ["z", "b", "z"], b: [], c: null }),
    );
    expect([...scopes]).toEqual([
      ["a", ["b", "z"]],
      ["b", []],
      ["c", null],
    ]);
    expect(rejected).toBe(0);
  });

  it("leaves out an entry that is not an array of non-empty strings (that instance stays unknown) and counts it", () => {
    const { scopes, rejected } = parseConnectorScopes(
      JSON.stringify({
        good: ["team"],
        text: "team",
        number: [1],
        blank: [""],
        nested: [["team"]],
        object: { team: true },
        flag: true,
      }),
    );
    expect([...scopes.keys()]).toEqual(["good"]);
    expect(rejected).toBe(6);
  });

  it("is empty and invalid (not a count of entries) for a file that is not a JSON object", () => {
    for (const text of ["", "{", "[]", '"x"', "null", "7"]) {
      expect(parseConnectorScopes(text), text).toEqual({
        scopes: new Map(),
        rejected: 0,
        file: "invalid",
      });
    }
  });

  it("keeps a key named like an Object prototype member as an ordinary instance id", () => {
    const { scopes } = parseConnectorScopes('{"__proto__": ["x"], "constructor": ["y"]}');
    expect(scopes.get("__proto__")).toEqual(["x"]);
    expect(scopes.get("constructor")).toEqual(["y"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("loading", () => {
  const failing = (code: string | undefined) => () => {
    throw Object.assign(new Error("read failed"), code === undefined ? {} : { code });
  };

  it("no file (ENOENT): nothing configured, told as absent", () => {
    expect(loadConnectorScopes(failing("ENOENT"))).toEqual({
      scopes: new Map(),
      rejected: 0,
      file: "absent",
    });
  });

  it("a file that cannot be read (any other error) is told as unreadable, every instance unknown", () => {
    for (const code of ["EACCES", "EISDIR", "EIO", undefined]) {
      expect(loadConnectorScopes(failing(code)), String(code)).toEqual({
        scopes: new Map(),
        rejected: 0,
        file: "unreadable",
      });
    }
  });

  it("a file that is read is parsed", () => {
    const loaded = loadConnectorScopes(() => '{"a":["x"],"b":"bad"}');
    expect(loaded.scopes.get("a")).toEqual(["x"]);
    expect(loaded).toMatchObject({ rejected: 1, file: "read" });
  });

  it("the public repository ships no file, so this build configures nothing", () => {
    expect(existsSync(fileURLToPath(CONNECTOR_SCOPES_FILE))).toBe(false);
    expect(CONNECTOR_SCOPES).toEqual({ scopes: new Map(), rejected: 0, file: "absent" });
  });

  it("the file is site/config/connector-scopes.json at the repository root", () => {
    const path = fileURLToPath(CONNECTOR_SCOPES_FILE);
    expect(path).toBe(resolve(import.meta.dirname, "../../site/config/connector-scopes.json"));
  });
});

describe("copying into the instance rows", () => {
  let db: SqlDriver;
  const configured = () =>
    db.all("SELECT id, configured_scope FROM connector_instances ORDER BY id");
  beforeEach(() => {
    db = openBetterSqlite3(":memory:");
    migrate(db);
    for (const id of ["a", "b", "c"]) registerConnectorInstance(db, id, "k");
  });

  it("sets the named instances and leaves the others unknown, first or not", () => {
    applyConfiguredScopes(
      db,
      new Map([
        ["c", ["team"]],
        ["a", ["x", "y"]],
      ]),
    );
    expect(configured()).toEqual([
      { id: "a", configured_scope: '["x","y"]' },
      { id: "b", configured_scope: null },
      { id: "c", configured_scope: '["team"]' },
    ]);
  });

  it("clears a scope the file no longer names (the file decides, not what an earlier build stored)", () => {
    applyConfiguredScopes(
      db,
      new Map([
        ["a", ["x"]],
        ["b", ["y"]],
      ]),
    );
    applyConfiguredScopes(db, new Map([["a", ["x"]]]));
    expect(configured()).toEqual([
      { id: "a", configured_scope: '["x"]' },
      { id: "b", configured_scope: null },
      { id: "c", configured_scope: null },
    ]);
  });

  it("a build with no file clears every instance (unknown), never keeping a stored one", () => {
    applyConfiguredScopes(db, new Map([["a", ["x"]]]));
    applyConfiguredScopes(db, new Map());
    expect(configured().every((r) => r.configured_scope === null)).toBe(true);
  });

  it("one instance's scope is copied alone", () => {
    applyConfiguredScope(
      db,
      "b",
      new Map([
        ["a", ["x"]],
        ["b", ["y"]],
      ]),
    );
    expect(configured()).toEqual([
      { id: "a", configured_scope: null },
      { id: "b", configured_scope: '["y"]' },
      { id: "c", configured_scope: null },
    ]);
  });

  it("is what the Broker reads for a source of the instance", () => {
    saveSourceRecord(db, "b", { externalId: "e", title: "t", body: "b" });
    applyConfiguredScopes(db, new Map([["b", ["y", "x"]]]));
    const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    expect(readSourceVersion(db, id)?.configuredScope).toEqual(["x", "y"]);
  });
});
