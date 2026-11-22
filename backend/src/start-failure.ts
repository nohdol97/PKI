// What the backend tells the shell about a refused start (I04-R7): a fixed class,
// never the error's message (it can carry a path or file text; V01-R13).
import { LedgerReapplyError } from "@pki/knowledge-engine";
import { errorClass } from "@pki/providers";
import { IdentityKeyMissingError, LedgerUnavailableError } from "@pki/storage";
import { UnregisteredAdapterError } from "./derivative-coverage.ts";
import { ScopePolicyNotImplementedError, UnknownScopePolicyError } from "./scope-policy.ts";
import { SiteRegistrationInvalidError } from "./site-registration.ts";

export type StartFailureReason =
  | "identity-key-missing"
  | "scope-policy-not-implemented"
  | "scope-policy-invalid"
  | "adapter-unregistered"
  | "ledger-reapply-failed"
  | "ledger-unavailable"
  | "site-registration-invalid";
export type StartFailureReport = {
  type: "failed";
  reason?: StartFailureReason;
  /** With `ledger-reapply-failed`: the ledger line number (never its content). */
  line?: number;
};

/**
 * Never throws: a thrown value is untrusted (a fork's code can throw anything), and an `instanceof` against a
 * Proxy with a throwing `getPrototypeOf`, or a field getter that throws, would otherwise stop the failure
 * message from being posted. Such a value is reported without a reason, as an unknown one.
 */
export function startFailureReport(error?: unknown): StartFailureReport {
  try {
    return classify(error);
  } catch {
    return { type: "failed" };
  }
}

function classify(error: unknown): StartFailureReport {
  if (error instanceof LedgerUnavailableError) {
    return { type: "failed", reason: "ledger-unavailable" };
  }
  if (error instanceof LedgerReapplyError) {
    return { type: "failed", reason: "ledger-reapply-failed", line: error.seq };
  }
  if (error instanceof IdentityKeyMissingError)
    return { type: "failed", reason: "identity-key-missing" };
  if (error instanceof ScopePolicyNotImplementedError) {
    return { type: "failed", reason: "scope-policy-not-implemented" };
  }
  if (error instanceof UnknownScopePolicyError)
    return { type: "failed", reason: "scope-policy-invalid" };
  if (error instanceof UnregisteredAdapterError) {
    return { type: "failed", reason: "adapter-unregistered" };
  }
  if (error instanceof SiteRegistrationInvalidError) {
    return { type: "failed", reason: "site-registration-invalid" };
  }
  return { type: "failed" };
}

/**
 * The one line the shell prints to stderr for a refused start: the error's class only (its
 * message can carry a path or file text, V01-R13), except the fixed notice of a policy this
 * repository leaves to the deployment, which names no data (I04-H2 ①), and the codes and counts of
 * a registration that stops the start (fixed words and numbers, I05-R9).
 */
export function startFailureLine(error: unknown): string {
  try {
    if (error instanceof SiteRegistrationInvalidError) {
      return `backend start failed: ${error.message}`;
    }
    if (
      error instanceof ScopePolicyNotImplementedError ||
      error instanceof UnknownScopePolicyError
    ) {
      return error.message;
    }
    if (!(error instanceof Error)) return `backend start failed: ${typeof error}`;
    // a project class that carries a reason is named as it is; any other name could be a thrower's own (W4)
    return `backend start failed: ${startFailureReport(error).reason !== undefined ? error.name : errorClass(error)}`;
  } catch {
    return "backend start failed: other";
  }
}
