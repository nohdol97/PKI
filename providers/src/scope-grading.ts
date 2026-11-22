// The grade a scope gives (I01-R15, S08). The public repository has one general class for
// every access scope (ADR 0014), so its mapping answers general for all of them. A
// deployment fork brings its own mapping through the composition point; the Broker applies
// it to a source's scope, and for an imported (claimed) scope only after comparing the claim
// with the scope the deployment configured (broker.ts).
import type { DataClassification } from "@pki/contracts";
import type { AccessScope } from "@pki/storage";

export interface ScopeGrading {
  /** The class a scope has; null is a scope nobody knows. */
  grade(scope: AccessScope): DataClassification;
  /** The strictest class: what a claim gets that cannot be shown no looser than the configured scope. */
  strictest(): DataClassification;
}

export const publicScopeGrading: ScopeGrading = Object.freeze({
  grade: () => "general",
  strictest: () => "general",
});
