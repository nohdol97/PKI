// The class a scope gives (I01-R15, S08). The synthetic class is the manifest's alone (ADR 0014,
// V01-R7): a scope can never give it, so the classes a mapping may answer are the closed set
// below, and the Broker refuses any other answer (`scope-unjudged`). The public repository has
// one such class for every access scope (ADR 0014); a deployment fork brings its own mapping.
//
// To introduce a class of its own a fork edits, together: `DATA_CLASSES` in
// `packages/contracts/src/provider.ts` (least strict first), `SCOPE_CLASSES` here, `asScopeClass`
// and `strictest(graded)` in `providers/src/broker.ts` (which today reduce every call to
// synthetic or general), the egress rules and the execution gate that read the class, and its
// `ScopeGrading`. The mapping need not be monotone with its policy: the Broker takes the stricter
// of the claim's class and the configured scope's class itself, so a claim never widens.
import type { DataClassification } from "@pki/contracts";
import type { AccessScope } from "@pki/storage";

/** The classes a scope may give: every class but synthetic. */
export const SCOPE_CLASSES = ["general"] as const satisfies readonly DataClassification[];
export type ScopeClass = (typeof SCOPE_CLASSES)[number];

export interface ScopeGrading {
  /** The class a scope has; null is a scope nobody knows. */
  grade(scope: AccessScope): ScopeClass;
  /**
   * The strictest of `classes`; with none, the strictest class there is. A claim that cannot
   * be shown no looser than the configured scope gets `strictest([])`.
   */
  strictest(classes: readonly ScopeClass[]): ScopeClass;
}

export const publicScopeGrading: ScopeGrading = Object.freeze({
  grade: () => "general",
  strictest: () => "general",
});
