// I07-T02 (I07-R2, R3, R4; I07-C3 `connector-scopes.bind`): the instance scopes a registration
// carries (`SiteRegistration.connectorScopes`, an untrusted value) are read into one table, and the
// table is copied into `connector_instances.configured_scope` (I01-R15). What is missing or not
// well-formed is unknown (null) and never a wider scope. Synthetic values only.
import {
  migrate,
  readSourceVersion,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyConfiguredScope,
  applyConfiguredScopes,
  bindConnectorScopes,
} from "./connector-scopes.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

describe("what a registration's value binds (C3)", () => {
  it("maps an instance id to a normalized scope, or to null", () => {
    const bound = bindConnectorScopes({ a: ["z", "b", "z"], b: [], c: null });
    expect([...bound.scopes]).toEqual([
      ["a", ["b", "z"]],
      ["b", []],
      ["c", null],
    ]);
    expect(bound).toMatchObject({ state: "bound", rejected: 0, entries: 3, configured: 2 });
  });

  it("① a value that is not an object is not used at all: invalid, nothing configured", () => {
    for (const value of [[], ["a"], null, "x", 7, true, Symbol("s")]) {
      expect(bindConnectorScopes(value), String(typeof value)).toEqual({
        scopes: new Map(),
        state: "invalid",
        rejected: 0,
        entries: 0,
        configured: 0,
      });
    }
  });

  it("no value at all is absent", () => {
    expect(bindConnectorScopes(undefined)).toEqual({
      scopes: new Map(),
      state: "absent",
      rejected: 0,
      entries: 0,
      configured: 0,
    });
  });

  it("② leaves out an entry that is not an array of non-empty strings (that instance stays unknown) and counts it", () => {
    const bound = bindConnectorScopes({
      good: ["team"],
      text: "team",
      number: [1],
      blank: [""],
      nested: [["team"]],
      object: { team: true },
      flag: true,
    });
    expect([...bound.scopes.keys()]).toEqual(["good"]);
    expect(bound).toMatchObject({ state: "bound", rejected: 6, entries: 7, configured: 1 });
  });

  it("③ a null entry stays unknown and is not a configured entry", () => {
    const bound = bindConnectorScopes({ a: null, b: null });
    expect([...bound.scopes]).toEqual([
      ["a", null],
      ["b", null],
    ]);
    expect(bound).toMatchObject({ state: "empty", configured: 0, rejected: 0 });
  });

  it("an empty object and an object whose entries are all refused are empty", () => {
    expect(bindConnectorScopes({})).toMatchObject({ state: "empty", configured: 0, entries: 0 });
    expect(bindConnectorScopes({ a: "x" })).toMatchObject({
      state: "empty",
      configured: 0,
      rejected: 1,
    });
  });

  it("④ keys named like Object prototype members are ordinary instance ids and pollute nothing", () => {
    const value = JSON.parse('{"__proto__": ["x"], "constructor": ["y"], "toString": ["z"]}');
    const bound = bindConnectorScopes(value);
    expect(bound.scopes.get("__proto__")).toEqual(["x"]);
    expect(bound.scopes.get("constructor")).toEqual(["y"]);
    expect(bound.scopes.get("toString")).toEqual(["z"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("④ reads own keys only: what the value inherits is never an instance's scope", () => {
    const inherited = Object.create({ heir: ["wide"] }) as Record<string, unknown>;
    inherited.own = ["narrow"];
    const bound = bindConnectorScopes(inherited);
    expect([...bound.scopes.keys()]).toEqual(["own"]);
  });

  it("④ a value that throws when read is unknown, never a throw out of the start", () => {
    const throwing = {
      get a() {
        throw new Error("boom");
      },
    };
    expect(bindConnectorScopes(throwing)).toMatchObject({ state: "invalid", configured: 0 });
    const proxied = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    expect(bindConnectorScopes(proxied)).toMatchObject({ state: "invalid", configured: 0 });
  });

  it("④ a sparse array is a refused entry, and an array that changes between reads is stored as the one copy that was checked", () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = bindConnectorScopes({ a: [, "x"], ok: ["y"] });
    expect(sparse).toMatchObject({ state: "bound", rejected: 1, entries: 2, configured: 1 });
    expect(sparse.scopes.has("a")).toBe(false);
    let reads = 0;
    const shifting = new Proxy(["x"], {
      get(target, key, receiver) {
        if (key === "length") return 1;
        if (key === "0") return reads++ === 0 ? "x" : 7;
        return Reflect.get(target, key, receiver);
      },
    });
    // read once: what the copy held is what is checked and stored, never a later read's value
    const changed = bindConnectorScopes({ a: shifting, ok: ["y"] });
    expect(changed.scopes.get("a")).toEqual(["x"]);
    expect(changed).toMatchObject({ state: "bound", rejected: 0, configured: 2 });
    for (const scope of changed.scopes.values()) {
      expect(scope === null || scope.every((s) => typeof s === "string" && s !== "")).toBe(true);
    }
  });

  it("④ never widens: every bound scope is exactly the normalized entry the value held", () => {
    const value = { a: ["b", "a", "a"], c: ["z"], d: ["x", 1], e: null };
    const bound = bindConnectorScopes(value);
    for (const [id, scope] of bound.scopes) {
      const held = (value as Record<string, unknown>)[id];
      if (scope === null) expect(held).toBeNull();
      else expect(scope.every((s) => (held as string[]).includes(s))).toBe(true);
    }
    expect(bound.scopes.has("d")).toBe(false);
  });
});

describe("copying into the instance rows", () => {
  let db: SqlDriver;
  const configured = () =>
    db.all("SELECT id, configured_scope FROM connector_instances ORDER BY id");
  beforeEach(() => {
    db = freshDb();
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
