// The scope policy a deployment chooses (I04-R14, S21; the policy itself is storage's
// `ScopePolicy`). The public repository has the default only: the name `site` is the
// fork's place, and naming it here stops the start with a `배포처 후속` notice.
import { defaultScopePolicy, type ScopePolicy } from "@pki/storage";

/** The scope policies a deployment can name (I04-R14, S21): the public repository's own and the fork's. */
export const SCOPE_POLICIES = ["default", "site"] as const;

/** `scopePolicy: "site"` is the fork's place (S21): the public repository stops the start there. */
export class ScopePolicyNotImplementedError extends Error {
  override name = "ScopePolicyNotImplementedError";
  constructor() {
    super('배포처 후속: scopePolicy "site"는 미구현, 배포처 후속');
  }
}

/** A name that is none of `SCOPE_POLICIES` (a typo must not fall back to the default). */
export class UnknownScopePolicyError extends Error {
  override name = "UnknownScopePolicyError";
  constructor(empty = false) {
    super(
      empty
        ? `scopePolicy is empty; name one of: ${SCOPE_POLICIES.join(", ")} or leave it unset`
        : `scopePolicy must be one of: ${SCOPE_POLICIES.join(", ")}`,
    );
  }
}

/**
 * The scope policy the deployment chose (I04-R14): `default` when none is named. `site` is the
 * fork's implementation and stops the start here; any other name stops it as well, never
 * choosing a looser policy by silence (fail closed).
 */
export function productScopePolicy(name: string = "default"): ScopePolicy {
  if (name === "default") return defaultScopePolicy;
  if (name === "site") throw new ScopePolicyNotImplementedError();
  throw new UnknownScopePolicyError(name.trim() === "");
}

/** The scope policy named in the environment (`PKI_SCOPE_POLICY`); the entries pass it to `bootBackend`. */
export const scopePolicyFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  env.PKI_SCOPE_POLICY;
