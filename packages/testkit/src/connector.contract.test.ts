// I01-R25 `contract-suite.red`: for each of the 21 violation codes, a double whose
// main fault is that violation makes checkConnector return exactly that code,
// after the suppression rules; each suppression rule has its own case. The base
// every double departs from is the scripted Connector, which passes the suite
// (`connector.contract.v2`, with the public Connectors' own test files).
import {
  ConnectorNotImplementedError,
  type Change,
  type ChangeSet,
  type Connector,
  type ConnectorCapabilities,
  type HealthStatus,
  type SourceRecord,
} from "@pki/contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_VIOLATION_CODES,
  checkConnector,
  type ConnectorCheckCode,
  connectorContract,
  type ConnectorScenario,
  type ConnectorViolationCode,
} from "./connector.contract.ts";
import { ScriptedConnector, type ScriptEntry } from "./scripted-connector.ts";

const AT = "2026-11-22T00:00:00Z";
const FULL: ConnectorCapabilities = {
  incremental: true,
  deletes: true,
  accessScope: true,
  fullRescan: true,
  deletionsOnRescan: true,
};

const record = (
  namespace: string,
  externalId: string,
  revision: number,
  patch: Partial<SourceRecord> & Record<string, unknown> = {},
): SourceRecord => ({
  namespace,
  externalId,
  revision,
  schemaVersion: 2,
  title: `title of ${externalId}`,
  body: `body of ${externalId}`,
  accessScope: ["team"],
  ...patch,
});
const upsert = (r: SourceRecord): Change => ({ kind: "upsert", record: r });
const tombstone = (externalId: string, revision: number): Change => ({
  kind: "delete",
  namespace: "",
  externalId,
  revision,
  at: AT,
});
const BLOCKS = [{ start: 0, end: 4, locator: { format: "txt" as const, line: 1 } }];

/**
 * The origin before: two namespaces share an external id, a scope change, a
 * source deleted after its upsert (`e`) and one never seen (`gone`).
 */
const initial = (): ScriptEntry[] => [
  upsert(record("", "a", 1)),
  upsert(record("", "b", 1, { blocks: BLOCKS })),
  upsert(record("space", "a", 2)),
  upsert(record("", "c", 3)),
  upsert(record("", "e", 1)),
  tombstone("e", 1),
  {
    kind: "scope-change",
    namespace: "",
    externalId: "b",
    revision: 1,
    accessScope: ["team", "guests"],
    at: AT,
  },
  tombstone("gone", 1),
];
/**
 * The origin after: `a` edited (revision up), `b` at the same revision with only
 * its scope changed, `c` deleted and reported on rescan, `e` gone for good.
 */
const later = (): ScriptEntry[] => [
  upsert(record("", "a", 2, { body: "body of a, edited" })),
  upsert(record("", "b", 1, { blocks: BLOCKS, accessScope: ["team", "guests"] })),
  upsert(record("space", "a", 2)),
  tombstone("c", 3),
  tombstone("gone", 1),
];
const scenario = (
  entries: { initial?: ScriptEntry[]; later?: ScriptEntry[] } = {},
): ConnectorScenario => ({
  config: { entries: entries.initial ?? initial() },
  later: { entries: entries.later ?? later() },
});
/** The same origin for a Connector that declares no access scope. */
const withoutScope = (r: SourceRecord): SourceRecord => {
  const copy = { ...r };
  delete copy.accessScope;
  return copy;
};
const unscoped = (entries: ScriptEntry[]): ScriptEntry[] =>
  entries
    .filter((e) => e.kind !== "scope-change")
    .map((e) => (e.kind === "upsert" ? upsert(withoutScope(e.record)) : e));
const replace = (entries: ScriptEntry[], externalId: string, by: ScriptEntry): ScriptEntry[] =>
  entries.map((e) =>
    e.kind === "upsert" && e.record.namespace === "" && e.record.externalId === externalId ? by : e,
  );

type Double = { create: () => Connector; scenario: ConnectorScenario };
const scripted = (capabilities: Partial<ConnectorCapabilities> = FULL) =>
  new ScriptedConnector({ capabilities: { ...FULL, ...capabilities } });
const base = (s: ConnectorScenario = scenario()): Double => ({
  create: () => scripted(),
  scenario: s,
});

/** Drops `c` from what a one-change page returns: the pages depend on the size. */
class SizeDependent extends ScriptedConnector {
  override async getChanges(cursor: string | null, opts: { limit: number; signal: AbortSignal }) {
    const page = await super.getChanges(cursor, opts);
    if (opts.limit !== 1) return page;
    return {
      ...page,
      changes: page.changes.filter((c) => !(c.kind === "upsert" && c.record.externalId === "c")),
    };
  }
}
/** Ignores the limit; on a one-change read it also adds an unknown source. */
class LimitIgnoring extends ScriptedConnector {
  readonly alsoDiffer: boolean;
  constructor(alsoDiffer = false) {
    super({ capabilities: FULL });
    this.alsoDiffer = alsoDiffer;
  }
  override async getChanges(cursor: string | null, opts: { limit: number; signal: AbortSignal }) {
    const page = await super.getChanges(cursor, { ...opts, limit: 1000 });
    if (!this.alsoDiffer || opts.limit !== 1 || cursor !== null) return page;
    return { ...page, changes: [...page.changes, upsert(record("", "extra", 1))] };
  }
}
/** Hands its second page's cursor back unchanged. */
class Stalling extends SizeDependent {
  override async getChanges(cursor: string | null, opts: { limit: number; signal: AbortSignal }) {
    if (cursor === "offset:2") return { changes: [], nextCursor: "offset:2", hasMore: true };
    return super.getChanges(cursor, opts);
  }
  override async getDocument(ref: { namespace: string; externalId: string }) {
    const doc = await super.getDocument(ref);
    return doc && { ...doc, title: "not what it delivered" };
  }
}

const RED: Record<ConnectorViolationCode, () => Double> = {
  "manifest-invalid": () => ({
    create: () => scripted({ fullRescan: false }),
    scenario: scenario(),
  }),
  "sdk-version-mismatch": () => ({
    create: () => new ScriptedConnector({ capabilities: FULL, schemaVersion: 1 }),
    scenario: scenario(),
  }),
  "responds-before-init": () => ({
    create: () =>
      new (class extends ScriptedConnector {
        override async getDocument(ref: { namespace: string; externalId: string }) {
          return super.getDocument(ref).catch(() => null);
        }
      })({ capabilities: FULL }),
    scenario: scenario(),
  }),
  "unhealthy-after-init": () => ({
    create: () =>
      new (class extends ScriptedConnector {
        override async healthCheck(): Promise<HealthStatus> {
          return { state: "unavailable", reason: "origin down" };
        }
      })({ capabilities: FULL }),
    scenario: scenario(),
  }),
  // Also proves the first suppression rule: no `unhealthy-after-init` beside it.
  "health-threw": () => ({
    create: () =>
      new (class extends ScriptedConnector {
        override async healthCheck(): Promise<HealthStatus> {
          throw new Error("health probe crashed");
        }
      })({ capabilities: FULL }),
    scenario: scenario(),
  }),
  "limit-exceeded": () => ({ create: () => new LimitIgnoring(), scenario: scenario() }),
  "page-size-dependent": () => ({
    create: () => new SizeDependent({ capabilities: FULL }),
    scenario: scenario(),
  }),
  "duplicate-identity": () =>
    base(scenario({ initial: [upsert(record("", "b", 1, { blocks: BLOCKS })), ...initial()] })),
  "no-progress": () => ({
    create: () =>
      new (class extends ScriptedConnector {
        override async getChanges(
          cursor: string | null,
          opts: { limit: number; signal: AbortSignal },
        ) {
          if (cursor === "offset:2") return { changes: [], nextCursor: "offset:2", hasMore: true };
          return super.getChanges(cursor, opts);
        }
      })({ capabilities: FULL }),
    scenario: scenario(),
  }),
  "changes-after-final-cursor": () => ({
    create: () =>
      new (class extends ScriptedConnector {
        override async getChanges(
          cursor: string | null,
          opts: { limit: number; signal: AbortSignal },
        ): Promise<ChangeSet> {
          const page = await super.getChanges(cursor, opts);
          if (cursor === null || page.changes.length > 0 || page.hasMore) return page;
          return { ...page, changes: [upsert(record("", "a", 1))] };
        }
      })({ capabilities: FULL }),
    scenario: scenario(),
  }),
  "record-schema": () =>
    base(
      scenario({
        initial: replace(initial(), "c", upsert(record("", "c", 3, { dataClass: "public" }))),
      }),
    ),
  "invalid-blocks": () =>
    base(
      scenario({
        initial: replace(
          initial(),
          "c",
          upsert(
            record("", "c", 3, {
              blocks: [{ start: 0, end: 999, locator: { format: "pdf", page: 1 } }],
            }),
          ),
        ),
      }),
    ),
  "capability-deletes": () => ({
    create: () => scripted({ deletes: false, deletionsOnRescan: false }),
    scenario: scenario(),
  }),
  "capability-access-scope": () =>
    base(scenario({ initial: replace(initial(), "c", upsert(withoutScope(record("", "c", 3)))) })),
  "revision-not-increasing": () =>
    base(
      scenario({
        later: replace(later(), "a", upsert(record("", "a", 1, { body: "body of a, edited" }))),
      }),
    ),
  "tombstone-revision-below-upsert": () =>
    base(
      scenario({
        later: later().map((e) =>
          e.kind === "delete" && e.externalId === "c" ? tombstone("c", 2) : e,
        ),
      }),
    ),
  "rescan-deletion-missing": () =>
    base(
      scenario({ later: later().filter((e) => !(e.kind === "delete" && e.externalId === "c")) }),
    ),
  "rejected-position-invalid": () =>
    base(
      scenario({
        initial: [...initial(), { kind: "rejected", at: "Line 12: text", code: "schema" }],
      }),
    ),
  "get-document-mismatch": () => ({
    create: () =>
      new (class extends ScriptedConnector {
        override async getDocument(ref: { namespace: string; externalId: string }) {
          const doc = await super.getDocument(ref);
          return doc && { ...doc, title: "not what it delivered" };
        }
      })({ capabilities: FULL }),
    scenario: scenario(),
  }),
  // Ignores a namespace it does not know: the same id elsewhere is not null.
  "get-document-unknown": () => ({
    create: () =>
      new (class extends ScriptedConnector {
        override async getDocument(ref: { namespace: string; externalId: string }) {
          if (ref.namespace === "" || ref.namespace === "space") return super.getDocument(ref);
          return super.getDocument({ namespace: "", externalId: ref.externalId });
        }
      })({ capabilities: FULL }),
    scenario: scenario(),
  }),
  "abort-ignored": () => ({
    create: () =>
      new (class extends ScriptedConnector {
        override async getChanges(
          cursor: string | null,
          opts: { limit: number; signal: AbortSignal },
        ) {
          return super.getChanges(cursor, { ...opts, signal: new AbortController().signal });
        }
      })({ capabilities: FULL }),
    scenario: scenario(),
  }),
};

describe("contract-suite.red", () => {
  it("names exactly the 21 codes of the I01-R25 table, in its order", () => {
    const spec = readFileSync(
      resolve(import.meta.dirname, "../../../docs/specs/2026-11-21-I01-connector-sdk.md"),
      "utf8",
    );
    const section = spec.slice(spec.indexOf("**I01-R25 "), spec.indexOf("**I01-R26 "));
    const codes = [...section.matchAll(/^\s*\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
    expect(codes).toHaveLength(21);
    expect([...CONNECTOR_VIOLATION_CODES]).toEqual(codes);
  });

  it("finds nothing wrong with the base the doubles depart from", async () => {
    expect(await checkConnector(base().create, base().scenario)).toEqual([]);
  });

  it.each(CONNECTOR_VIOLATION_CODES)(
    "a double violating %s yields exactly that code",
    async (code) => {
      const double = RED[code]();
      expect(await checkConnector(double.create, double.scenario)).toEqual([code]);
    },
  );

  it.each<[string, () => Double, ConnectorViolationCode]>([
    [
      "a record in another SDK version is a version mismatch, not a schema failure",
      () =>
        base(
          scenario({
            initial: replace(initial(), "c", upsert(record("", "c", 3, { schemaVersion: 1 as 2 }))),
          }),
        ),
      "sdk-version-mismatch",
    ],
    [
      "a record naming its own instance fails the schema",
      () =>
        base(
          scenario({
            initial: replace(
              initial(),
              "c",
              upsert(record("", "c", 3, { connectorInstanceId: "x" })),
            ),
          }),
        ),
      "record-schema",
    ],
    [
      "a scope change from a Connector without the accessScope capability",
      () => ({
        create: () => scripted({ accessScope: false }),
        scenario: scenario({
          initial: [
            ...unscoped(initial()),
            {
              kind: "scope-change",
              namespace: "",
              externalId: "a",
              revision: 1,
              accessScope: ["team"],
              at: AT,
            },
          ],
          later: unscoped(later()),
        }),
      }),
      "capability-access-scope",
    ],
    [
      "a delete inside one read below the upsert just before it",
      () => base(scenario({ initial: [...initial(), tombstone("c", 2)] })),
      "tombstone-revision-below-upsert",
    ],
  ])("other shape: %s", async (...[, make, code]) => {
    const double = make();
    expect(await checkConnector(double.create, double.scenario)).toEqual([code]);
  });

  describe("suppression rules", () => {
    it("a read that exceeded the limit is not compared across page sizes", async () => {
      expect(await checkConnector(() => new LimitIgnoring(true), scenario())).toEqual([
        "limit-exceeded",
      ]);
    });

    it("a read with a duplicate identity is not compared across page sizes", async () => {
      const dup = [upsert(record("", "b", 1, { blocks: BLOCKS })), ...initial()];
      expect(
        await checkConnector(
          () => new SizeDependent({ capabilities: FULL }),
          scenario({ initial: dup }),
        ),
      ).toEqual(["duplicate-identity"]);
    });

    it("a read without progress skips the comparison and every check that needs its end", async () => {
      const s = scenario({
        later: replace(later(), "a", upsert(record("", "a", 1, { body: "body of a, edited" }))),
      });
      expect(await checkConnector(() => new Stalling({ capabilities: FULL }), s)).toEqual([
        "no-progress",
      ]);
    });

    it("the version is reported first and the manifest check does not look at it", async () => {
      const create = () =>
        new ScriptedConnector({ capabilities: { ...FULL, fullRescan: false }, schemaVersion: 1 });
      expect(await checkConnector(create, scenario())).toEqual([
        "manifest-invalid",
        "sdk-version-mismatch",
      ]);
    });

    it("a not-implemented placeholder yields not-implemented instead of violations", async () => {
      const placeholder = (): Connector => {
        const fail = () => Promise.reject(new ConnectorNotImplementedError());
        return {
          manifest: {
            type: "site-x",
            schemaVersion: 2,
            capabilities: { ...FULL, deletionsOnRescan: false },
          },
          initialize: fail,
          healthCheck: async () => ({ state: "unavailable", reason: "미구현, 배포처 후속" }),
          getChanges: fail,
          getDocument: fail,
        };
      };
      expect(await checkConnector(placeholder, { config: {} })).toEqual(["not-implemented"]);
    });

    it("an unreadable manifest is manifest-invalid alone", async () => {
      const create = () =>
        new (class extends ScriptedConnector {
          override get manifest(): never {
            throw new Error("no manifest");
          }
        })();
      expect(await checkConnector(create, scenario())).toEqual(["manifest-invalid"]);
    });

    it("a manifest without a capabilities object is manifest-invalid alone", async () => {
      const create = () =>
        new (class extends ScriptedConnector {
          override get manifest() {
            return { type: "scripted", schemaVersion: 2, capabilities: null as never };
          }
        })();
      expect(await checkConnector(create, scenario())).toEqual(["manifest-invalid"]);
    });
  });

  it("throws, not a code, when the scenario's config does not initialize the Connector", async () => {
    await expect(checkConnector(() => scripted(), { config: { nope: true } })).rejects.toThrow(
      /initialize/,
    );
  });
});

/** A Connector that answers only after initialize; the subclass hook for early answers. */
class Tracked extends ScriptedConnector {
  ready = false;
  override async initialize(config: unknown) {
    await super.initialize(config);
    this.ready = true;
  }
}
const noTombstones = (entries: ScriptEntry[]): ScriptEntry[] =>
  entries.filter((e) => e.kind !== "delete" && e.kind !== "access-revoked");
const overrideDocument = (
  answer: (ref: { namespace: string; externalId: string }, real: SourceRecord | null) => unknown,
) =>
  new (class extends ScriptedConnector {
    override async getDocument(ref: { namespace: string; externalId: string }) {
      return answer(ref, await super.getDocument(ref)) as SourceRecord | null;
    }
  })({ capabilities: FULL });
const finalPage = (answer: (page: ChangeSet) => ChangeSet) =>
  new (class extends ScriptedConnector {
    override async getChanges(cursor: string | null, opts: { limit: number; signal: AbortSignal }) {
      const page = await super.getChanges(cursor, opts);
      if (cursor === null || page.changes.length > 0 || page.hasMore) return page;
      return answer(page);
    }
  })({ capabilities: FULL });

// Each clause of a code's definition (I01-R25, R2, R3, T04 §4·§5) has its own
// double, so no clause can be dropped while the suite stays green (review F1).
describe("contract-suite.red, clause by clause", () => {
  it.each<[string, () => Double, ConnectorCheckCode[]]>([
    [
      "a capability that is not a boolean",
      () => ({
        create: () => scripted({ incremental: "yes" as unknown as boolean }),
        scenario: scenario(),
      }),
      ["manifest-invalid"],
    ],
    [
      "an empty manifest type",
      () => ({
        create: () => new ScriptedConnector({ type: " ", capabilities: FULL }),
        scenario: scenario(),
      }),
      ["manifest-invalid"],
    ],
    [
      "getChanges answering before initialize (getDocument refuses)",
      () => ({
        create: () =>
          new (class extends Tracked {
            override async getChanges(
              cursor: string | null,
              opts: { limit: number; signal: AbortSignal },
            ): Promise<ChangeSet> {
              if (!this.ready) return { changes: [], nextCursor: "", hasMore: false };
              return super.getChanges(cursor, opts);
            }
          })({ capabilities: FULL }),
        scenario: scenario(),
      }),
      ["responds-before-init"],
    ],
    [
      "an access scope on a record from a Connector without the capability",
      () => ({
        create: () => scripted({ accessScope: false }),
        scenario: scenario({
          initial: replace(unscoped(initial()), "c", upsert(record("", "c", 3))),
          later: unscoped(later()),
        }),
      }),
      ["capability-access-scope"],
    ],
    [
      "an access-revoked event from a Connector without the deletes capability",
      () => ({
        create: () => scripted({ deletes: false, deletionsOnRescan: false }),
        scenario: scenario({
          initial: [
            ...noTombstones(initial()),
            { kind: "access-revoked", namespace: "", externalId: "c", revision: 3, at: AT },
          ],
          later: noTombstones(later()),
        }),
      }),
      ["capability-deletes"],
    ],
    [
      "getDocument answering the empty-namespace unknown id",
      () => ({
        create: () =>
          overrideDocument((ref, real) =>
            ref.externalId === "contract-unknown-external-id"
              ? record("", ref.externalId, 1)
              : real,
          ),
        scenario: scenario(),
      }),
      ["get-document-unknown"],
    ],
    [
      "getDocument answering a deleted source",
      () => ({
        create: () =>
          overrideDocument((ref, real) =>
            ref.namespace === "" && ref.externalId === "e" ? record("", "e", 1) : real,
          ),
        scenario: scenario(),
      }),
      ["get-document-mismatch"],
    ],
    [
      "getDocument throwing for a delivered source",
      () => ({
        create: () =>
          overrideDocument((ref, real) => {
            if (ref.externalId === "c") throw new Error("lookup failed");
            return real;
          }),
        scenario: scenario(),
      }),
      ["get-document-mismatch"],
    ],
    [
      "getDocument after a scope change with other content",
      () => ({
        create: () =>
          overrideDocument((ref, real) =>
            ref.namespace === "" && ref.externalId === "b" && real ? { ...real, title: "x" } : real,
          ),
        scenario: scenario(),
      }),
      ["get-document-mismatch"],
    ],
    [
      "getDocument after a scope change without the new scope",
      () => ({
        create: () =>
          overrideDocument((ref, real) =>
            ref.namespace === "" && ref.externalId === "b" && real
              ? { ...real, accessScope: ["team"] }
              : real,
          ),
        scenario: scenario(),
      }),
      ["get-document-mismatch"],
    ],
    [
      "a rescan reporting access-revoked instead of delete",
      () =>
        base(
          scenario({
            later: later().map((e) =>
              e.kind === "delete" && e.externalId === "c" ? { ...e, kind: "access-revoked" } : e,
            ),
          }),
        ),
      ["rescan-deletion-missing"],
    ],
    [
      "the final cursor answering hasMore",
      () => ({
        create: () => finalPage((page) => ({ ...page, hasMore: true })),
        scenario: scenario(),
      }),
      ["changes-after-final-cursor"],
    ],
    [
      "the final cursor throwing",
      () => ({
        create: () =>
          finalPage(() => {
            throw new Error("origin closed");
          }),
        scenario: scenario(),
      }),
      ["changes-after-final-cursor"],
    ],
    [
      "a malformed tombstone event",
      () => base(scenario({ initial: [...initial(), tombstone("x", 0)] })),
      ["record-schema"],
    ],
    [
      "a malformed page",
      () => ({
        create: () =>
          new (class extends ScriptedConnector {
            override async getChanges(
              cursor: string | null,
              opts: { limit: number; signal: AbortSignal },
            ) {
              const page = await super.getChanges(cursor, opts);
              return (cursor === null ? { ...page, extra: true } : page) as ChangeSet;
            }
          })({ capabilities: FULL }),
        scenario: scenario(),
      }),
      ["record-schema"],
    ],
    [
      "a tombstone that only a one-change read leaves out",
      () => ({
        create: () =>
          new (class extends ScriptedConnector {
            override async getChanges(
              cursor: string | null,
              opts: { limit: number; signal: AbortSignal },
            ) {
              const page = await super.getChanges(cursor, opts);
              if (opts.limit !== 1) return page;
              return {
                ...page,
                changes: page.changes.filter(
                  (c) => !(c.kind === "delete" && c.externalId === "gone"),
                ),
              };
            }
          })({ capabilities: FULL }),
        scenario: scenario(),
      }),
      ["page-size-dependent"],
    ],
    [
      "a stall that repeats the same page is no-progress alone, not a duplicate too",
      () => ({
        create: () =>
          new (class extends ScriptedConnector {
            override async getChanges(
              _cursor: string | null,
              opts: { limit: number; signal: AbortSignal },
            ) {
              return super.getChanges(null, opts);
            }
          })({ capabilities: FULL }),
        scenario: scenario(),
      }),
      ["no-progress"],
    ],
    [
      "a readable version is reported even when the capabilities are missing",
      () => ({
        create: () =>
          new (class extends ScriptedConnector {
            override get manifest() {
              return { type: "scripted", schemaVersion: 1, capabilities: undefined as never };
            }
          })(),
        scenario: scenario(),
      }),
      ["manifest-invalid", "sdk-version-mismatch"],
    ],
  ])("%s", async (...[, make, codes]) => {
    const double = make();
    expect(await checkConnector(double.create, double.scenario)).toEqual(codes);
  });

  it.each<[string, () => Double]>([
    [
      "a tombstone then an upsert of the same source in one read is not a duplicate",
      () =>
        base(
          scenario({
            initial: [...initial(), tombstone("f", 1), upsert(record("", "f", 2))],
            later: [...later(), tombstone("f", 2)],
          }),
        ),
    ],
    [
      "without deletionsOnRescan, a source that vanishes on rescan without a delete is fine",
      () => ({
        create: () => scripted({ deletionsOnRescan: false }),
        scenario: scenario({
          later: later().filter((e) => !(e.kind === "delete" && e.externalId === "c")),
        }),
      }),
    ],
  ])("green: %s", async (_name, make) => {
    const double = make();
    expect(await checkConnector(double.create, double.scenario)).toEqual([]);
  });

  it("a read longer than maxPages throws instead of reporting no-progress", async () => {
    await expect(checkConnector(() => scripted(), { ...scenario(), maxPages: 3 })).rejects.toThrow(
      /maxPages/,
    );
    const many = Array.from({ length: 40 }, (_, i) => upsert(record("", `m${i}`, 1)));
    expect(
      await checkConnector(() => scripted(), { config: { entries: many }, maxPages: 41 }),
    ).toEqual([]);
  });
});

// connector.contract.v2: the scripted Connector itself, with and without access scopes.
connectorContract("scripted", () => scripted(), scenario());
connectorContract("scripted without access scopes", () => scripted({ accessScope: false }), {
  config: { entries: unscoped(initial()) },
  later: { entries: unscoped(later()) },
});
