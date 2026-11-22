// The public repository's default ScopePolicy (I04-R14, I04-T09). One PC, one user:
// nothing is refused, but a scope's strictness is still compared (null, "unknown",
// is stricter than every value, and values that differ cannot be ordered), so a
// fork's policy has the same questions to answer. `scope.inherit` (unit part) and
// the comparison part of `scope.changed`.
import { describe, expect, it } from "vitest";
import { atLeastAsStrict, defaultScopePolicy, type AccessScope } from "./index.ts";

const A: AccessScope = ["a"];
const B: AccessScope = ["b"];
const AB: AccessScope = ["a", "b"];
const policy = defaultScopePolicy;

describe("the default policy's compare (I04-R14)", () => {
  it("is equal for the same array, for two empty arrays and for two nulls", () => {
    expect(policy.compare(A, ["a"])).toBe("equal");
    expect(policy.compare([], [])).toBe("equal");
    expect(policy.compare(null, null)).toBe("equal");
  });

  it("takes null (unknown) as stricter than any array, and an array as looser than null", () => {
    expect(policy.compare(null, A)).toBe("stricter");
    expect(policy.compare(null, [])).toBe("stricter");
    expect(policy.compare(A, null)).toBe("looser");
    expect(policy.compare([], null)).toBe("looser");
  });

  it("cannot order two different arrays, a subset and an empty array included", () => {
    expect(policy.compare(A, B)).toBe("incomparable");
    expect(policy.compare(A, AB)).toBe("incomparable");
    expect(policy.compare(AB, A)).toBe("incomparable");
    expect(policy.compare([], A)).toBe("incomparable");
  });
});

describe("atLeastAsStrict is derived from compare and true only when proven (I04-R14)", () => {
  it("is true for a equal to b, or a null; false for looser and incomparable", () => {
    expect(atLeastAsStrict(policy, A, ["a"])).toBe(true);
    expect(atLeastAsStrict(policy, null, null)).toBe(true);
    expect(atLeastAsStrict(policy, null, A)).toBe(true);
    expect(atLeastAsStrict(policy, A, null)).toBe(false);
    expect(atLeastAsStrict(policy, A, B)).toBe(false);
    expect(atLeastAsStrict(policy, A, AB)).toBe(false);
  });

  it("asks the policy it is given, not the default", () => {
    const looser = { ...policy, compare: () => "looser" as const };
    expect(atLeastAsStrict(looser, A, A)).toBe(false);
    const stricter = { ...policy, compare: () => "stricter" as const };
    expect(atLeastAsStrict(stricter, A, B)).toBe(true);
  });
});

describe("strictest (I04-R14)", () => {
  it("is the scope itself for one scope, and for the same scope repeated", () => {
    expect(policy.strictest([A])).toEqual(A);
    expect(policy.strictest([A, ["a"], A])).toEqual(A);
  });

  it("is incomparable (to be treated as strictest) when different arrays are mixed, in the order given", () => {
    expect(policy.strictest([A, B])).toEqual({ incomparable: [A, B] });
    expect(policy.strictest([B, A, B])).toEqual({ incomparable: [B, A] });
  });

  it("is null as soon as one scope is unknown, wherever it stands in the list", () => {
    expect(policy.strictest([A, null])).toBeNull();
    expect(policy.strictest([A, B, null])).toBeNull();
    expect(policy.strictest([null, A])).toBeNull();
  });

  it("is null, the strictest, for no scope at all (nothing proves the scope)", () => {
    expect(policy.strictest([])).toBeNull();
  });
});

describe("combinable and allows (I04-R14)", () => {
  it("are always true under the default policy, for every purpose and any scopes", () => {
    for (const scopes of [[], [A], [A, B], [null], [A, null, B]] as AccessScope[][]) {
      expect(policy.combinable(scopes)).toBe(true);
      for (const purpose of ["display", "search", "notify", "answer"] as const) {
        expect(policy.allows(scopes, purpose)).toBe(true);
      }
    }
  });
});
