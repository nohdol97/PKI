// I05-T03 `site.registration` (I05-R6 to R9, I05-C6): what a registration is checked for and how it
// merges onto the base set. One test per code of the R9 table, each with a registration that has
// that violation alone; the public kinds are walked from the constant, never named here.
import { CONNECTOR_SDK_VERSION, type Connector } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { SITE_CONNECTOR_KINDS } from "./public-kinds.ts";
import { fixtureConnectors, productConnectors, type ConnectorSet } from "./composition.ts";
import type { ConnectorFactory } from "./connectors.ts";
import { PUBLIC_CONNECTOR_KINDS } from "./public-kinds.ts";
import {
  checkSiteRegistration,
  mergeSiteRegistration,
  publicSite,
  scopeGradingValid,
  type SiteRegistration,
} from "./site-registration.ts";

const connectorOf = (type: string): Connector => ({
  manifest: {
    type,
    schemaVersion: CONNECTOR_SDK_VERSION,
    capabilities: {
      incremental: false,
      deletes: false,
      accessScope: false,
      fullRescan: false,
      deletionsOnRescan: false,
    },
  },
  initialize: async () => {},
  healthCheck: async () => ({ state: "ok" }),
  getChanges: async () => ({ changes: [], nextCursor: "0", hasMore: false }),
  getDocument: async () => null,
});
const kindOf =
  (name: string): ConnectorFactory =>
  () =>
    connectorOf(name);
const instance = (id: string, kind: string) => ({ id, kind, config: {} });
const withFork = (extra: SiteRegistration = {}): SiteRegistration => ({
  connectorKinds: { fork: kindOf("fork"), ...extra.connectorKinds },
  ...(extra.connectorInstances ? { connectorInstances: extra.connectorInstances } : {}),
  ...(extra.scopeGrading ? { scopeGrading: extra.scopeGrading } : {}),
});

describe("site.registration: checkSiteRegistration answers a list of codes", () => {
  it("is empty for the empty registration and for publicSite", () => {
    expect(checkSiteRegistration({})).toEqual([]);
    expect(checkSiteRegistration(publicSite)).toEqual([]);
  });

  it("is empty for a registration that adds a kind with an instance", () => {
    expect(
      checkSiteRegistration(withFork({ connectorInstances: [instance("fork-1", "fork")] })),
    ).toEqual([]);
  });

  it("kind-name-invalid: a name outside ^[a-z][a-z0-9-]{0,63}$", () => {
    for (const name of ["Bad", "1abc", "a_b", "", "a".repeat(65)]) {
      expect(checkSiteRegistration({ connectorKinds: { [name]: kindOf(name) } }), name).toEqual([
        "kind-name-invalid",
      ]);
    }
    expect(
      checkSiteRegistration({ connectorKinds: { ["a".repeat(64)]: kindOf("a".repeat(64)) } }),
    ).toEqual([]);
  });

  it("kind-reserved: each public kind, walked from the constant", () => {
    expect(PUBLIC_CONNECTOR_KINDS.length).toBeGreaterThan(0);
    for (const name of PUBLIC_CONNECTOR_KINDS) {
      expect(checkSiteRegistration({ connectorKinds: { [name]: kindOf(name) } }), name).toEqual([
        "kind-reserved",
      ]);
    }
  });

  it("instance-id-invalid: 128 characters pass, 129 and the empty id fail", () => {
    const at = (id: string) =>
      checkSiteRegistration(withFork({ connectorInstances: [instance(id, "fork")] }));
    expect(at("i".repeat(128))).toEqual([]);
    expect(at("i".repeat(129))).toEqual(["instance-id-invalid"]);
    expect(at("")).toEqual(["instance-id-invalid"]);
  });

  it("instance-id-duplicate: the same id twice, once per extra occurrence", () => {
    expect(
      checkSiteRegistration(
        withFork({
          connectorInstances: [instance("a", "fork"), instance("a", "fork"), instance("a", "fork")],
        }),
      ),
    ).toEqual(["instance-id-duplicate", "instance-id-duplicate"]);
  });

  describe("instance-credentials-invalid (I06-R2, I06-C2)", () => {
    const declared = (credentials: unknown) =>
      withFork({
        connectorInstances: [{ ...instance("fork-1", "fork"), credentials } as never],
      });
    const bad: Array<[string, unknown]> = [
      ["a name outside the shape: upper case", ["Token"]],
      ["a name outside the shape: a digit first", ["1token"]],
      ["a name outside the shape: 17 characters", ["a".repeat(17)]],
      ["a name outside the shape: a trailing newline", ["token\n"]],
      ["a name that is not a string", [1]],
      ["a declaration that is not a list", "token"],
      ["the same name twice", ["token", "token"]],
      ["more than MAX_CREDENTIAL_SLOTS names", Array.from({ length: 9 }, (_, i) => `s${i}`)],
    ];
    it.each(bad)("%s", (_name, credentials) => {
      expect(checkSiteRegistration(declared(credentials))).toEqual([
        "instance-credentials-invalid",
      ]);
    });
    it("passes the longest allowed name, the most allowed names, none, and no declaration", () => {
      for (const ok of [
        ["a".repeat(16)],
        Array.from({ length: 8 }, (_, i) => `s${i}`),
        [],
        undefined,
      ]) {
        expect(checkSiteRegistration(declared(ok))).toEqual([]);
      }
    });
    it("a declaration that throws when read is invalid, and the instance is left out of the merge", () => {
      const hostile = new Proxy([], {
        get() {
          throw new Error("no");
        },
      });
      expect(checkSiteRegistration(declared(hostile))).toEqual(["instance-credentials-invalid"]);
      const merged = mergeSiteRegistration(declared(["Bad"]), { instances: [], kinds: {} });
      expect(merged.connectors.instances).toEqual([]);
    });
  });

  it("instance-kind-unknown: a kind that is nowhere", () => {
    expect(
      checkSiteRegistration(withFork({ connectorInstances: [instance("a", "nowhere")] })),
    ).toEqual(["instance-kind-unknown"]);
  });

  it("instance-kind-reserved: each public kind and each placeholder that was not replaced", () => {
    for (const kind of [...PUBLIC_CONNECTOR_KINDS, ...SITE_CONNECTOR_KINDS]) {
      expect(
        checkSiteRegistration(withFork({ connectorInstances: [instance("mine", kind)] })),
        kind,
      ).toEqual(["instance-kind-reserved"]);
    }
  });

  it("instance-kind-reserved: a kind the base set has and the registration did not register", () => {
    const base: ConnectorSet = { instances: [], kinds: { "test-only": kindOf("test-only") } };
    expect(
      checkSiteRegistration(
        withFork({ connectorInstances: [instance("mine", "test-only")] }),
        base,
      ),
    ).toEqual(["instance-kind-reserved"]);
  });

  it("a reserved kind named for an instance after kind-reserved rejected it is both codes", () => {
    const name = PUBLIC_CONNECTOR_KINDS[0] as string;
    expect(
      checkSiteRegistration({
        connectorKinds: { [name]: kindOf(name) },
        connectorInstances: [instance("mine", name)],
      }),
    ).toEqual(["kind-reserved", "instance-kind-reserved"]);
  });

  it("instance-id-reserved: the ids of the public composition points and of a placeholder not replaced", () => {
    const ids = [
      ...fixtureConnectors("/synthetic/f.jsonl").instances.map((i) => i.id),
      ...SITE_CONNECTOR_KINDS,
    ];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(
        checkSiteRegistration(withFork({ connectorInstances: [instance(id, "fork")] })),
        id,
      ).toEqual(["instance-id-reserved"]);
    }
  });

  it("instance-id-reserved: an id the base set has (a set a test passes)", () => {
    const base: ConnectorSet = {
      instances: [instance("held", "test-only")],
      kinds: { "test-only": kindOf("test-only") },
    };
    expect(
      checkSiteRegistration(withFork({ connectorInstances: [instance("held", "fork")] }), base),
    ).toEqual(["instance-id-reserved"]);
  });

  it("kind-factory-threw: the factory throws when asked once", () => {
    const throwing: ConnectorFactory = () => {
      throw new Error("config /secret/path");
    };
    expect(checkSiteRegistration({ connectorKinds: { fork: throwing } })).toEqual([
      "kind-factory-threw",
    ]);
  });

  it("kind-manifest-mismatch: manifest.type differs from the kind's name, or cannot be read", () => {
    expect(checkSiteRegistration({ connectorKinds: { fork: kindOf("other") } })).toEqual([
      "kind-manifest-mismatch",
    ]);
    const unreadable: ConnectorFactory = () =>
      ({
        get manifest(): never {
          throw new Error("no manifest");
        },
      }) as unknown as Connector;
    expect(checkSiteRegistration({ connectorKinds: { fork: unreadable } })).toEqual([
      "kind-manifest-mismatch",
    ]);
  });

  it("asks no factory of a kind that was not registered", () => {
    let asked = 0;
    const counting: ConnectorFactory = () => {
      asked++;
      return connectorOf("Bad");
    };
    checkSiteRegistration({
      connectorKinds: { Bad: counting, [PUBLIC_CONNECTOR_KINDS[0] as string]: counting },
    });
    expect(asked).toBe(0);
  });

  it("scope-grading-invalid: an answer outside the allowed classes, or a mapping that throws", () => {
    const answers = (answer: string) => ({
      grade: () => answer as "general",
      strictest: () => answer as "general",
    });
    expect(checkSiteRegistration({ scopeGrading: answers("synthetic") })).toEqual([
      "scope-grading-invalid",
    ]);
    expect(
      checkSiteRegistration({
        scopeGrading: {
          grade: () => {
            throw new Error("no");
          },
          strictest: () => "general",
        },
      }),
    ).toEqual(["scope-grading-invalid"]);
    expect(checkSiteRegistration({ scopeGrading: answers("general") })).toEqual([]);
  });

  it("scopeGradingValid asks grade(null), grade([]), strictest([]) and strictest(all) and wants the strictest class for the first three", () => {
    const classes = ["loose", "strict"];
    const asked: string[] = [];
    const record = (
      over: Partial<Record<"null" | "empty" | "none" | "all", string>> = {},
    ): Parameters<typeof scopeGradingValid>[0] => ({
      grade: (scope) => {
        asked.push(`grade:${scope === null ? "null" : scope.join(",")}`);
        return (scope === null ? (over.null ?? "strict") : (over.empty ?? "strict")) as "general";
      },
      strictest: (list) => {
        asked.push(`strictest:${list.join(",")}`);
        return (list.length === 0 ? (over.none ?? "strict") : (over.all ?? "strict")) as "general";
      },
    });
    expect(scopeGradingValid(record(), classes)).toBe(true);
    expect(asked).toEqual(["grade:null", "grade:", "strictest:", "strictest:loose,strict"]);
    expect(scopeGradingValid(record({ null: "loose" }), classes)).toBe(false);
    expect(scopeGradingValid(record({ empty: "loose" }), classes)).toBe(false);
    expect(scopeGradingValid(record({ none: "loose" }), classes)).toBe(false);
    expect(scopeGradingValid(record({ all: "other" }), classes)).toBe(false);
  });

  it("reports one code per occurrence and keeps the order: kinds, instances, probes, grading", () => {
    expect(
      checkSiteRegistration({
        connectorKinds: { Bad: kindOf("Bad"), fork: kindOf("other") },
        connectorInstances: [instance("", "fork"), instance("a", "nowhere")],
        scopeGrading: { grade: () => "synthetic" as "general", strictest: () => "general" },
      }),
    ).toEqual([
      "kind-name-invalid",
      "instance-id-invalid",
      "instance-kind-unknown",
      "kind-manifest-mismatch",
      "scope-grading-invalid",
    ]);
  });
});

describe("site.registration: merging onto the base set", () => {
  const product = productConnectors();

  it("an empty registration leaves the base as it is", () => {
    const merged = mergeSiteRegistration(publicSite, product);
    expect(merged.violations).toEqual([]);
    expect(merged.connectors.kinds).toEqual(product.kinds);
    expect(merged.connectors.instances).toEqual(product.instances);
  });

  it("a placeholder name replaces that kind and drops that placeholder's instance; the others stay", () => {
    const forkMail = kindOf("site-mail");
    const mine = instance("mail-1", "site-mail");
    const { connectors, violations } = mergeSiteRegistration(
      { connectorKinds: { "site-mail": forkMail }, connectorInstances: [mine] },
      product,
    );
    expect(violations).toEqual([]);
    expect(connectors.kinds["site-mail"]).toBe(forkMail);
    expect(connectors.kinds["site-wiki"]).toBe(product.kinds["site-wiki"]);
    expect(connectors.instances.map((i) => i.id).sort()).toEqual([
      "mail-1",
      "site-messenger",
      "site-wiki",
    ]);
  });

  it("the replaced placeholder's own id is free for the fork's instance", () => {
    const { connectors, violations } = mergeSiteRegistration(
      {
        connectorKinds: { "site-mail": kindOf("site-mail") },
        connectorInstances: [instance("site-mail", "site-mail")],
      },
      product,
    );
    expect(violations).toEqual([]);
    expect(connectors.instances.filter((i) => i.id === "site-mail")).toHaveLength(1);
  });

  it("a placeholder that was not replaced stays, and its follow-up notice still comes at initialize", async () => {
    const { connectors } = mergeSiteRegistration(withFork(), product);
    const placeholder = connectors.kinds["site-messenger"]?.();
    await expect(placeholder?.initialize({})).rejects.toThrow("미구현, 배포처 후속");
    expect(connectors.instances.some((i) => i.id === "site-messenger")).toBe(true);
  });

  it("a new kind is added to the base's", () => {
    const fork = kindOf("fork");
    const { connectors } = mergeSiteRegistration(
      { connectorKinds: { fork }, connectorInstances: [instance("f1", "fork")] },
      product,
    );
    expect(Object.keys(connectors.kinds).sort()).toEqual([
      "fork",
      "site-mail",
      "site-messenger",
      "site-wiki",
    ]);
    expect(connectors.kinds["fork"]).toBe(fork);
    expect(connectors.instances.map((i) => i.id)).toContain("f1");
  });

  it("a public kind is not registered: the base's one stays, also over a base that has the test kind", () => {
    const base = fixtureConnectors("/synthetic/f.jsonl");
    for (const name of PUBLIC_CONNECTOR_KINDS) {
      const mine = kindOf(name);
      const { connectors, violations } = mergeSiteRegistration(
        { connectorKinds: { [name]: mine } },
        base,
      );
      expect(violations, name).toEqual(["kind-reserved"]);
      expect(connectors.kinds[name], name).not.toBe(mine);
      expect(connectors.kinds[name], name).toBe(base.kinds[name]);
    }
  });

  it("a kind with a bad name is left out", () => {
    const { connectors } = mergeSiteRegistration(
      { connectorKinds: { Bad: kindOf("Bad") } },
      product,
    );
    expect(Object.keys(connectors.kinds)).not.toContain("Bad");
  });

  it("the instances that were refused are left out: a bad id, a repeat (the first one stays)", () => {
    const first = { id: "a", kind: "fork", config: { which: "first" } };
    const { connectors, violations } = mergeSiteRegistration(
      withFork({
        connectorInstances: [
          first,
          { id: "a", kind: "fork", config: { which: "second" } },
          instance("", "fork"),
        ],
      }),
      product,
    );
    expect(violations).toEqual(["instance-id-duplicate", "instance-id-invalid"]);
    expect(connectors.instances.filter((i) => i.kind === "fork")).toEqual([first]);
  });

  it("an instance that stops the start is left out of the merged set, as the other refused ones are", () => {
    const publicKind = PUBLIC_CONNECTOR_KINDS[0] as string;
    const { connectors, violations } = mergeSiteRegistration(
      withFork({
        connectorInstances: [
          instance("by-kind", publicKind),
          instance("fixtures", "fork"),
          instance("fine", "fork"),
        ],
      }),
      product,
    );
    expect(violations).toEqual(["instance-kind-reserved", "instance-id-reserved"]);
    expect(connectors.instances.filter((i) => ["by-kind", "fixtures"].includes(i.id))).toEqual([]);
    expect(connectors.instances.map((i) => i.id)).toContain("fine");
  });

  it("an instance of an unknown kind stays, so that the start can mark it unavailable", () => {
    const { connectors, violations } = mergeSiteRegistration(
      withFork({ connectorInstances: [instance("lost", "nowhere")] }),
      product,
    );
    expect(violations).toEqual(["instance-kind-unknown"]);
    expect(connectors.instances.map((i) => i.id)).toContain("lost");
    expect(Object.keys(connectors.kinds)).not.toContain("nowhere");
  });

  it("the registration is merged over a base the caller passed, not over the product's", () => {
    const base: ConnectorSet = {
      instances: [instance("seed", "seeded")],
      kinds: { seeded: kindOf("seeded") },
    };
    const { connectors } = mergeSiteRegistration(
      withFork({ connectorInstances: [instance("f1", "fork")] }),
      base,
    );
    expect(Object.keys(connectors.kinds).sort()).toEqual(["fork", "seeded"]);
    expect(connectors.instances.map((i) => i.id)).toEqual(["seed", "f1"]);
  });
});

describe("site.registration: the instance scopes' two check-only codes (I07-R5, I07-C6)", () => {
  const SCOPE = "synthetic-scope-marker-eeee";

  it("① connector-scopes-field-invalid: a value that is not an object", () => {
    for (const connectorScopes of [[], [SCOPE], null, SCOPE, 7, true]) {
      expect(checkSiteRegistration({ connectorScopes }), JSON.stringify(connectorScopes)).toEqual([
        "connector-scopes-field-invalid",
      ]);
    }
  });

  it("② connector-scopes-entry-invalid: one or more entries that are not an array of non-empty strings, once", () => {
    for (const connectorScopes of [
      { a: "x" },
      { a: [""] },
      { a: [1] },
      { a: [["x"]] },
      { a: { x: true } },
      { ok: [SCOPE], bad: "x", worse: [2] },
    ]) {
      expect(checkSiteRegistration({ connectorScopes }), JSON.stringify(connectorScopes)).toEqual([
        "connector-scopes-entry-invalid",
      ]);
    }
  });

  it("② a sparse array is entry-invalid", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(checkSiteRegistration({ connectorScopes: { a: [, "x"] } })).toEqual([
      "connector-scopes-entry-invalid",
    ]);
  });

  it("③ neither code for a well-formed value or for a registration without the field", () => {
    for (const site of [
      {},
      publicSite,
      { connectorScopes: undefined },
      { connectorScopes: {} },
      { connectorScopes: { a: [SCOPE, "b"], b: [], c: null } },
      { connectorScopes: JSON.parse('{"__proto__": ["x"]}') as unknown },
    ] satisfies SiteRegistration[]) {
      expect(checkSiteRegistration(site)).toEqual([]);
    }
  });

  it("a scopes violation comes after the others and does not hide them", () => {
    const codes = checkSiteRegistration({
      connectorKinds: { "Bad Name": kindOf("x") },
      scopeGrading: { grade: () => "nope" as never, strictest: () => "nope" as never },
      connectorScopes: { a: 1 },
    });
    expect(codes).toEqual([
      "kind-name-invalid",
      "scope-grading-invalid",
      "connector-scopes-entry-invalid",
    ]);
  });

  it("the codes are not the log codes (`connector-scopes-invalid` names the start's log line alone)", () => {
    const codes = checkSiteRegistration({ connectorScopes: 7 });
    expect(codes).not.toContain("connector-scopes-invalid" as never);
  });

  it("the merge is untouched: a scopes violation drops nothing and stops nothing", () => {
    const { connectors, violations } = mergeSiteRegistration(
      { connectorScopes: 7 },
      productConnectors(),
    );
    expect(violations).toEqual([]);
    expect(connectors).toEqual(productConnectors());
  });
});
