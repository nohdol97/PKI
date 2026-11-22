// The public repository's default ScopePolicy (I04-R14). It is one PC and one
// user (ARCHITECTURE 8), so it refuses nothing: `combinable` and `allows` are
// always true. It still answers the comparison questions the way a fork's policy
// must: `null` is a scope nobody knows, stricter than any value, and two values
// that differ cannot be ordered, so they are treated as the strictest together.
// A deployment replaces this module's export through the composition point
// (`scopePolicy: "site"` stops the start in the public repository).
import type { AccessScope, ScopeComparison, ScopePolicy } from "./derivatives.ts";

const sameValues = (a: readonly string[], b: readonly string[]) => {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

function compare(a: AccessScope, b: AccessScope): ScopeComparison {
  if (a === null || b === null) {
    if (a === b) return "equal";
    return a === null ? "stricter" : "looser";
  }
  return sameValues(a, b) ? "equal" : "incomparable";
}

function strictest(scopes: readonly AccessScope[]): AccessScope | { incomparable: AccessScope[] } {
  const distinct: AccessScope[] = [];
  for (const scope of scopes) {
    if (!distinct.some((seen) => compare(seen, scope) === "equal")) distinct.push(scope);
  }
  // nothing proves a scope for no input: the strictest, unknown
  if (distinct.length === 0) return null;
  const top = distinct.findIndex((candidate) =>
    distinct.every((other) => {
      const c = compare(candidate, other);
      return c === "stricter" || c === "equal";
    }),
  );
  return top >= 0 ? (distinct[top] as AccessScope) : { incomparable: distinct };
}

export const defaultScopePolicy: ScopePolicy = Object.freeze({
  compare,
  strictest,
  combinable: () => true,
  allows: () => true,
});

/**
 * `policy.combinable`, with every doubt a refusal (I04-R14, fail closed): a policy that
 * throws, or answers anything but `true`, has not shown the scopes may be put together.
 */
export function mayCombine(
  policy: Pick<ScopePolicy, "combinable">,
  scopes: readonly AccessScope[],
): boolean {
  try {
    return policy.combinable(scopes) === true;
  } catch {
    return false;
  }
}
