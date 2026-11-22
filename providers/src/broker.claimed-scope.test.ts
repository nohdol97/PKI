// I01-C2 `scope.claimed-grade` (I01-R15), the Broker's part: a source whose scope is a
// user's claim (`sources.scope_claimed`, an import) is graded by comparing the claim with
// the scope the deployment configured for its instance (`ScopePolicy.compare`, I04-T09);
// the claim can narrow the grade and never widen it. A deployment fork brings the mapping
// scope -> grade (S08) and its policy; both are fakes here. The fake mapping is made
// lenient where a real one is strict (`grade(null)` is "synthetic") so a Broker that asks
// the mapping where it must answer "strictest" is seen.
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

let compareCalls: [AccessScope, AccessScope][];
let compareOverride: ((a: AccessScope, b: AccessScope) => unknown) | undefined;

const policy: ScopePolicy = {
  compare: (a, b) => {
    compareCalls.push([a, b]);
    return (compareOverride ? compareOverride(a, b) : fakeCompare(a, b)) as ScopeComparison;
  },
  strictest: () => null,
  combinable: () => true,
  allows: () => true,
};

let gradeOverride: ((scope: AccessScope) => unknown) | undefined;
let strictestOverride: (() => unknown) | undefined;
/** public and open (and open-*) scopes are the loose ones: synthetic here; team and secret are general. */
const lenient = (l: string) => l === "public" || l.startsWith("open");
const grading: ScopeGrading = {
  grade: (scope) =>
    (gradeOverride
      ? gradeOverride(scope)
      : // null is unknown: a real mapping makes it strict, this one does not (see the header)
        scope === null || (scope.length > 0 && scope.every(lenient))
        ? "synthetic"
        : "general") as "general",
  strictest: () => (strictestOverride ? strictestOverride() : "general") as "general",
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
  provider = new FakeProvider({ answer: () => ({ items: [], facts: [], relations: [] }) });
  ledger = createUserActionLedger();
  candidates = new Map();
  seen = [];
  compareCalls = [];
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
  const instance = o.instance ?? `${kind}-inst`;
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
  schemaVersion: 2,
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

describe("scope.claimed-grade ①-④: a claim is compared with the configured scope", () => {
  it("① a claim looser than the configured scope is graded as the configured scope", async () => {
    // both outcomes differ from the claim's own grade (synthetic)
    expect(await classOf([claim(["open"], ["team"])])).toBe("general");
    // the configured scope's grade is synthetic here, so "the strictest" would be wrong
    expect(await classOf([claim(["public"], ["open"])])).toBe("synthetic");
  });

  it("② an equal claim has the claim's grade", async () => {
    expect(await classOf([claim(["open"], ["open"])])).toBe("synthetic");
  });

  it("② a stricter claim has the claim's grade (a claim narrows)", async () => {
    // configured open is synthetic; the claim team is stricter and general
    expect(await classOf([claim(["team"], ["open"])])).toBe("general");
  });

  it("③ an incomparable claim is graded as the strictest grade", async () => {
    // both scopes would be synthetic; only "strictest" is general
    expect(await classOf([claim(["open-eu"], ["open"])])).toBe("general");
  });

  it("④ a configured scope that is unknown (null) is graded as the strictest, without asking the mapping", async () => {
    // grade(null) is synthetic in this mapping: a Broker asking it would answer synthetic
    expect(await classOf([claim(["open"], null)])).toBe("general");
  });

  it("④ a claim that is unknown (null) is graded as the strictest even against a known configured scope", async () => {
    expect(await classOf([store({ scope: null, configured: ["open"] })])).toBe("general");
  });

  it("④ a claim that is not a scope at all (text that is not an array) is graded as the strictest", async () => {
    expect(await classOf([store({ scope: "garbage-text", configured: ["open"] })])).toBe("general");
    expect(await classOf([store({ scope: "[1,2", configured: ["open"] })])).toBe("general");
  });

  it("asks compare(claim, configured), in that order, with the stored scopes", async () => {
    await classOf([claim(["team", "open"], ["secret"])]);
    expect(compareCalls).toEqual([[["open", "team"], ["secret"]]]);
  });
});

describe("scope.claimed-grade ⑤: the scope of anything but a claim is its grade as it stands", () => {
  it("is graded by the mapping of its own scope, not compared with the configured one", async () => {
    // own open is synthetic; compared with configured team it would be "looser" -> general
    const id = store({ claimed: false, scope: JSON.stringify(["open"]), configured: ["team"] });
    expect(await classOf([id])).toBe("synthetic");
    expect(compareCalls).toEqual([]);
  });

  it("an unknown (null) own scope is the mapping's answer for null", async () => {
    expect(await classOf([store({ claimed: false, scope: null })])).toBe("synthetic");
  });
});

describe("scope.claimed-grade: every source of the input is graded, the first or not", () => {
  const loose = () => claim(["open"], ["open"]); // synthetic
  const tight = () => claim(["open-eu"], ["open"]); // incomparable -> general

  it("grades synthetic only when all sources are", async () => {
    expect(await classOf([loose(), loose()])).toBe("synthetic");
  });

  it("a source that grades strictest makes the call general, in any position", async () => {
    expect(await classOf([tight(), loose(), loose()])).toBe("general");
    expect(await classOf([loose(), tight(), loose()])).toBe("general");
    expect(await classOf([loose(), loose(), tight()])).toBe("general");
  });

  it("applies to the evidence of a candidate item, the last of several included", async () => {
    candidates.set("item-1", {
      name: "n",
      evidenceSourceVersionIds: [loose(), loose(), tight()],
    });
    expect(await classOf([loose()], { candidateItemIds: ["item-1"] })).toBe("general");
    candidates.set("item-2", { name: "m", evidenceSourceVersionIds: [loose(), loose()] });
    expect(await classOf([loose()], { candidateItemIds: ["item-2"] })).toBe("synthetic");
  });
});

describe("scope.claimed-grade: a policy or mapping that cannot judge stops the request", () => {
  const stopped = async (ids: string[]) => {
    const before = provider.requests.length;
    expect(await call(extract(ids))).toEqual({ status: "rejected", reason: "scope-unjudged" });
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

  it("a mapping that throws, or answers a class that does not exist", async () => {
    const id = claim(["open"], ["open"]);
    gradeOverride = () => {
      throw new Error("mapping down");
    };
    await stopped([id]);
    for (const bad of [undefined, null, "secret", 1]) {
      gradeOverride = () => bad;
      await stopped([id]);
    }
  });

  it("a strictest that throws or is not a class, where the strictest is what the grade needs", async () => {
    const id = claim(["open-eu"], ["open"]); // incomparable: asks strictest
    strictestOverride = () => {
      throw new Error("down");
    };
    await stopped([id]);
    strictestOverride = () => "top-secret";
    await stopped([id]);
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
    expect(await call(extract([good], { candidateItemIds: ["item-1"] }))).toEqual({
      status: "rejected",
      reason: "scope-unjudged",
    });
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

  it("a listed text from the fixtures Connector stays synthetic whatever its scope grades", async () => {
    const id = store({
      kind: "test-fixtures",
      claimed: false,
      scope: JSON.stringify(["team"]),
      ...synthetic,
    });
    expect(await classOf([id])).toBe("synthetic");
  });

  it("a listed text imported as a claim is graded by its scope (V01 correction: import is not a trusted kind)", async () => {
    // the claim is the strictest-graded one; its being listed does not lift it
    expect(
      await classOf([
        store({ scope: JSON.stringify(["open-eu"]), configured: ["open"], ...synthetic }),
      ]),
    ).toBe("general");
    // and a claim the mapping grades synthetic is synthetic by the scope, not by the list
    expect(
      await classOf([
        store({ scope: JSON.stringify(["open"]), configured: ["open"], ...synthetic }),
      ]),
    ).toBe("synthetic");
  });

  it("an unlisted text under the fixtures kind is graded by its scope, not by its kind", async () => {
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
    expect(compareCalls).toEqual([]);
    expect(seen.every((c) => c === "general")).toBe(true);
  });
});
