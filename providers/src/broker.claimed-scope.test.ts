// I01-C2 `scope.claimed-grade` (I01-R15), the Broker's part: a source whose scope is a
// user's claim (`sources.scope_claimed`, an import) is graded by comparing the claim with
// the scope the deployment configured for its instance (`ScopePolicy.compare`, I04-T09);
// the claim can narrow the grade and never widen it. A deployment fork brings the mapping
// scope -> class (S08) and its policy; both are fakes here. A scope can never give the synthetic
// class (the manifest's alone), so the mapping has one legal answer and the branches are told
// apart by what the Broker asked (`calls`), not by the class that comes out.
import type { BrokerRequest } from "@pki/contracts";
import {
  migrate,
  registerConnectorInstance,
  saveSourceRecord,
  setConfiguredScope,
  type AccessScope,
  type ScopeComparison,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeProvider } from "@pki/testkit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createBroker, type CandidateItem, type ScopeGrading } from "./broker.ts";
import { createUserActionLedger } from "./user-actions.ts";

/** Labels: public < open < team < secret in strictness; "open-*" labels are unordered among themselves. */
const RANK: Record<string, number> = { public: 0, open: 1, team: 2, secret: 3 };
const rankOf = (scope: readonly string[]) => Math.max(...scope.map((l) => RANK[l] ?? 99));

function fakeCompare(a: AccessScope, b: AccessScope): ScopeComparison {
  if (a === null || b === null) {
    if (a === b) return "equal";
    return a === null ? "stricter" : "looser";
  }
  if (a.join() === b.join()) return "equal";
  if (a.some((l) => !(l in RANK)) || b.some((l) => !(l in RANK))) return "incomparable";
  const [x, y] = [rankOf(a), rankOf(b)];
  return x === y ? "equal" : x > y ? "stricter" : "looser";
}

/** What the Broker asked of the policy and the mapping, in order. */
let calls: string[];
let compareOverride: ((a: AccessScope, b: AccessScope) => unknown) | undefined;
let gradeOverride: ((scope: AccessScope) => unknown) | undefined;
let strictestOverride: ((classes: readonly string[]) => unknown) | undefined;

const policy: ScopePolicy = {
  compare: (a, b) => {
    calls.push(`compare:${a?.join("+") ?? "null"}|${b?.join("+") ?? "null"}`);
    return (compareOverride ? compareOverride(a, b) : fakeCompare(a, b)) as ScopeComparison;
  },
  strictest: () => null,
  combinable: () => true,
  allows: () => true,
};
const grading: ScopeGrading = {
  grade: (scope) => {
    calls.push(`grade:${scope?.join("+") ?? "null"}`);
    return (gradeOverride ? gradeOverride(scope) : "general") as "general";
  },
  strictest: (classes) => {
    calls.push(`strictest:[${classes.join(",")}]`);
    return (strictestOverride ? strictestOverride(classes) : "general") as "general";
  },
};

let db: SqlDriver;
let provider: FakeProvider;
let ledger: ReturnType<typeof createUserActionLedger>;
let candidates: Map<string, CandidateItem>;
let seen: string[];

function makeBroker(withScope = true) {
  return createBroker({
    db,
    provider: () => provider,
    userActions: ledger.redeemer,
    candidates: { lookup: (id) => candidates.get(id) },
    egress: { decide: () => ({ allowed: true, destination: "fake", policyVersion: "pv" }) },
    execution: {
      decide: (input) => {
        seen.push(input.classification);
        return { run: true };
      },
    },
    recorder: {
      record: () => undefined,
      begin: () => () => undefined,
      attemptTimes: () => [],
      interruptStarted: () => 0,
    },
    clock: { now: () => 0, sleep: async () => undefined },
    ...(withScope ? { scope: { policy, grading } } : {}),
  });
}
let broker: ReturnType<typeof createBroker>;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  provider = new FakeProvider({
    answer: () => ({ items: [], facts: [], relations: [], terms: [], definitions: [] }),
  });
  ledger = createUserActionLedger();
  candidates = new Map();
  seen = [];
  calls = [];
  compareOverride = undefined;
  gradeOverride = undefined;
  strictestOverride = undefined;
  broker = makeBroker();
});

let seq = 0;
interface Stored {
  claimed?: boolean;
  /** The source's access_scope as stored (a JSON array text or a plain value). */
  scope?: string | null;
  configured?: AccessScope;
  kind?: string;
  instance?: string;
  title?: string;
  body?: string;
}
/** One source the way an import leaves it; returns its version id. Content is unlisted unless given. */
function store(o: Stored = {}): string {
  const kind = o.kind ?? "jsonl-import";
  const instance = o.instance ?? `${kind}-inst-${seq + 1}`;
  registerConnectorInstance(db, instance, kind);
  if (o.configured !== undefined) setConfiguredScope(db, instance, o.configured);
  const externalId = `ext-${++seq}`;
  saveSourceRecord(db, instance, {
    externalId,
    title: o.title ?? `자료 ${seq}`,
    body: o.body ?? `이 자료는 합성 목록에 없는 본문 ${seq}`,
  });
  db.run("UPDATE sources SET scope_claimed = ?, access_scope = ? WHERE external_id = ?", [
    o.claimed === false ? 0 : 1,
    o.scope === undefined ? JSON.stringify(["open"]) : o.scope,
    externalId,
  ]);
  return String(db.all("SELECT max(id) AS id FROM source_versions")[0]?.id);
}
const claim = (scope: string[], configured: AccessScope) =>
  store({ scope: JSON.stringify(scope), configured });

const extract = (ids: string[], extra: Partial<BrokerRequest> = {}) => ({
  taskKind: "extract" as const,
  sourceVersionIds: ids,
  candidateItemIds: [],
  schemaVersion: 6,
  budget: { timeoutMs: 1000 },
  retryable: false,
  ...extra,
});
const call = (request: object, b = broker) =>
  ledger.issuer.during((userActionId) => b.call({ origin: { userActionId }, ...request }));
const classOf = async (ids: string[], extra: Partial<BrokerRequest> = {}) => {
  const result = await call(extract(ids, extra));
  expect(result.status).toBe("ok");
  return provider.requests.at(-1)?.dataClassification;
};

const asked = async (ids: string[], extra: Partial<BrokerRequest> = {}) => {
  calls = [];
  expect(await classOf(ids, extra)).toBe("general");
  return calls;
};

describe("scope.claimed-grade ①-④: a claim is compared with the configured scope", () => {
  it("① a looser, equal or stricter claim is graded by both scopes' classes, the stricter taken", async () => {
    expect(await asked([claim(["open"], ["team"])])).toEqual([
      "compare:open|team",
      "grade:open",
      "grade:team",
      "strictest:[general,general]",
    ]);
    expect(await asked([claim(["open"], ["open"])])).toEqual([
      "compare:open|open",
      "grade:open",
      "grade:open",
      "strictest:[general,general]",
    ]);
    expect(await asked([claim(["secret"], ["team"])])).toEqual([
      "compare:secret|team",
      "grade:secret",
      "grade:team",
      "strictest:[general,general]",
    ]);
  });

  it("③ an incomparable claim is graded as the strictest class, no scope's class asked", async () => {
    expect(await asked([claim(["open-eu"], ["open"])])).toEqual([
      "compare:open-eu|open",
      "strictest:[]",
    ]);
  });

  it("④ a configured scope that is unknown (null) is graded as the strictest, without asking the policy or the mapping", async () => {
    expect(await asked([claim(["open"], null)])).toEqual(["strictest:[]"]);
  });

  it("④ a claim that is unknown (null) is graded as the strictest even against a known configured scope", async () => {
    expect(await asked([store({ scope: null, configured: ["open"] })])).toEqual(["strictest:[]"]);
  });

  it("④ a claim that is not a scope at all (text that is not an array) is graded as the strictest", async () => {
    expect(await asked([store({ scope: "garbage-text", configured: ["open"] })])).toEqual([
      "compare:garbage-text|open",
      "strictest:[]",
    ]);
    expect(await asked([store({ scope: "[1,2", configured: ["open"] })])).toEqual([
      "compare:[1,2|open",
      "strictest:[]",
    ]);
  });

  it("asks compare(claim, configured), in that order, with the stored scopes", async () => {
    expect((await asked([claim(["team", "open"], ["secret"])]))[0]).toBe(
      "compare:open+team|secret",
    );
  });
});

describe("scope.claimed-grade: a claim never gives a looser class than the configured scope", () => {
  // a policy that calls secret stricter than team: whatever the mapping says, the Broker asks for
  // the stricter of the two classes (a mapping that is not monotone cannot make the claim looser)
  it("takes the stricter of the two classes, for every comparison that shows the claim", async () => {
    const seenClasses: string[][] = [];
    strictestOverride = (classes) => {
      seenClasses.push([...classes]);
      return "general";
    };
    await classOf([claim(["secret"], ["team"])]);
    await classOf([claim(["open"], ["team"])]);
    await classOf([claim(["team"], ["team"])]);
    expect(seenClasses).toEqual([
      ["general", "general"],
      ["general", "general"],
      ["general", "general"],
    ]);
  });

  it("a class that would be looser (synthetic) from the mapping for the claim is refused, not returned", async () => {
    // the probe: the claim is stricter than the configured scope, the mapping calls it synthetic
    gradeOverride = (scope) => (scope?.includes("secret") ? "synthetic" : "general");
    expect(await call(extract([claim(["secret"], ["team"])]))).toEqual({
      status: "rejected",
      reason: "scope-unjudged",
    });
    expect(provider.requests).toEqual([]);
  });
});

describe("scope.claimed-grade ④: an instance row that no longer exists", () => {
  it("is an unknown configured scope: graded as the strictest, nothing compared", async () => {
    const id = claim(["open"], ["team"]);
    db.run("PRAGMA foreign_keys = OFF");
    db.run("DELETE FROM connector_instances");
    expect(await asked([id])).toEqual(["strictest:[]"]);
  });
});

describe("scope.claimed-grade ⑤: the scope of anything but a claim is its grade as it stands", () => {
  it("is graded by the mapping of its own scope, not compared with the configured one", async () => {
    const id = store({ claimed: false, scope: JSON.stringify(["open"]), configured: ["team"] });
    expect(await asked([id])).toEqual(["grade:open"]);
  });

  it("an unknown (null) own scope is the mapping's answer for null", async () => {
    expect(await asked([store({ claimed: false, scope: null })])).toEqual(["grade:null"]);
  });
});

describe("scope.claimed-grade: every source of the input is graded, the first or not", () => {
  const loose = () => claim(["open"], ["open"]);
  const tight = () => claim(["open-eu"], ["open"]);

  it("asks the policy and the mapping for each source, the last of several included", async () => {
    const got = await asked([loose(), tight(), loose()]);
    expect(got.filter((c) => c.startsWith("compare:"))).toEqual([
      "compare:open|open",
      "compare:open-eu|open",
      "compare:open|open",
    ]);
    expect(got.filter((c) => c === "strictest:[]")).toHaveLength(1);
  });

  it("applies to the evidence of a candidate item, the last of several included", async () => {
    candidates.set("item-1", {
      name: "n",
      evidenceSourceVersionIds: [loose(), loose(), tight()],
    });
    const got = await asked([loose()], { candidateItemIds: ["item-1"] });
    expect(got.filter((c) => c.startsWith("compare:"))).toEqual([
      "compare:open|open",
      "compare:open|open",
      "compare:open|open",
      "compare:open-eu|open",
    ]);
    expect(got.filter((c) => c === "strictest:[]")).toHaveLength(1);
  });
});

describe("scope.claimed-grade: a policy or mapping that cannot judge stops the request", () => {
  const stopped = async (ids: string[], extra: Partial<BrokerRequest> = {}) => {
    const before = provider.requests.length;
    expect(await call(extract(ids, extra))).toEqual({
      status: "rejected",
      reason: "scope-unjudged",
    });
    expect(provider.requests).toHaveLength(before);
  };

  it("a compare that throws", async () => {
    compareOverride = () => {
      throw new Error("policy down");
    };
    await stopped([claim(["open"], ["open"])]);
  });

  it("a compare that answers anything but one of the four comparisons", async () => {
    for (const bad of [undefined, null, "wider", true, 0, { stricter: true }]) {
      compareOverride = () => bad;
      await stopped([claim(["open"], ["open"])]);
    }
  });

  it("a mapping that throws, or answers anything but a class a scope may give (synthetic included)", async () => {
    const id = claim(["open"], ["open"]);
    gradeOverride = () => {
      throw new Error("mapping down");
    };
    await stopped([id]);
    for (const bad of [undefined, null, "secret", 1, "synthetic", "restricted"]) {
      gradeOverride = () => bad;
      await stopped([id]);
    }
  });

  it("a mapping that answers synthetic for a source that is not a claim", async () => {
    gradeOverride = () => "synthetic";
    await stopped([store({ claimed: false, scope: JSON.stringify(["open"]) })]);
  });

  it("a strictest that throws or answers anything but a class a scope may give, where the grade needs it", async () => {
    for (const id of [claim(["open-eu"], ["open"]), claim(["open"], ["open"])]) {
      strictestOverride = () => {
        throw new Error("down");
      };
      await stopped([id]);
      for (const bad of ["top-secret", "synthetic", undefined]) {
        strictestOverride = () => bad;
        await stopped([id]);
      }
    }
  });

  it("the failure of a later source stops the request (every source is judged)", async () => {
    const good = claim(["open"], ["open"]);
    const bad = claim(["team"], ["secret"]);
    compareOverride = (a) => {
      if (a?.includes("team")) throw new Error("policy down");
      return fakeCompare(a, ["open"]);
    };
    await stopped([good, claim(["open"], ["open"]), bad]);
    candidates.set("item-1", { name: "n", evidenceSourceVersionIds: [good, bad] });
    await stopped([good], { candidateItemIds: ["item-1"] });
  });
});

describe("scope.claimed-grade ⑦⑧: the synthetic class is the manifest's alone", () => {
  const synthetic = readFileSync(
    resolve(import.meta.dirname, "../../fixtures/test-connector.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { title: string; body: string; malicious?: boolean })
    .find((f) => !f.malicious) as { title: string; body: string };

  it("a listed text from the fixtures Connector stays synthetic, its scope never asked", async () => {
    const id = store({
      kind: "test-fixtures",
      claimed: false,
      scope: JSON.stringify(["team"]),
      ...synthetic,
    });
    calls = [];
    expect(await classOf([id])).toBe("synthetic");
    expect(calls).toEqual([]);
  });

  it("a listed text that came in by import is general (V01: imports are general), claimed or not", async () => {
    expect(
      await classOf([
        store({ scope: JSON.stringify(["open"]), configured: ["open"], ...synthetic }),
      ]),
    ).toBe("general");
    expect(
      await classOf([store({ claimed: false, scope: JSON.stringify(["open"]), ...synthetic })]),
    ).toBe("general");
  });

  it("an unlisted text under the fixtures kind is general, whatever its scope", async () => {
    const id = store({
      kind: "test-fixtures",
      scope: JSON.stringify(["team"]),
      configured: ["team"],
    });
    expect(await classOf([id])).toBe("general");
  });

  it("a namespace that says synthetic does not make a record synthetic", async () => {
    const id = store({
      kind: "test-fixtures",
      scope: JSON.stringify(["team"]),
      configured: ["team"],
    });
    db.run("UPDATE sources SET namespace = 'synthetic'");
    expect(await classOf([id])).toBe("general");
  });
});

describe("scope.claimed-grade: the public default", () => {
  it("grades every scope general, claimed or not, whatever the configured scope", async () => {
    const b = makeBroker(false);
    for (const o of [
      claim(["open"], ["open"]),
      claim(["open"], null),
      store({ claimed: false, scope: null }),
    ]) {
      const result = await call(extract([o]), b);
      expect(result.status).toBe("ok");
      expect(provider.requests.at(-1)?.dataClassification).toBe("general");
    }
    expect(calls).toEqual([]);
    expect(seen.every((c) => c === "general")).toBe(true);
  });
});
