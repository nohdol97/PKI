// The scope policy a deployment chooses (I04-R14, I05-R15, S21; the policy itself is storage's
// `ScopePolicy`). The public repository has the default only; a fork's registration brings its own.
// The name `site` asks for the registration's, and naming it where none is registered stops the
// start with a `배포처 후속` notice.
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
 * The scope policy the deployment chose (I04-R14, I05-R15), by the name a source run gives and the
 * policy the registration brings. No name: the registration's policy, else the default. `default`: the
 * default, whatever is registered. `site`: the registration's policy, and with none the start stops
 * here (the fork's place, `배포처 후속`). Any other name stops it as well, never choosing a looser
 * policy by silence (fail closed).
 */
export function productScopePolicy(name?: string, registered?: ScopePolicy): ScopePolicy {
  if (name === undefined) return registered ?? defaultScopePolicy;
  if (name === "default") return defaultScopePolicy;
  if (name === "site") {
    if (registered) return registered;
    throw new ScopePolicyNotImplementedError();
  }
  throw new UnknownScopePolicyError(name.trim() === "");
}

/** The scope policy named in the environment (`PKI_SCOPE_POLICY`); the entries pass it to `bootBackend`. */
export const scopePolicyFromEnv = (env: Readonly<Record<string, string | undefined>>) =>
  env.PKI_SCOPE_POLICY;
