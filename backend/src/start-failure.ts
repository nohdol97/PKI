// What the backend tells the shell about a refused start (I04-R7): a fixed class,
// never the error's message (it can carry a path or file text; V01-R13).
import { IdentityKeyMissingError } from "@pki/storage";
import { UnregisteredAdapterError } from "./derivative-coverage.ts";
import { ScopePolicyNotImplementedError, UnknownScopePolicyError } from "./scope-policy.ts";

export type StartFailureReason =
  | "identity-key-missing"
  | "scope-policy-not-implemented"
  | "scope-policy-invalid"
  | "adapter-unregistered";
export type StartFailureReport = { type: "failed"; reason?: StartFailureReason };

export function startFailureReport(error?: unknown): StartFailureReport {
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
  return { type: "failed" };
}

/**
 * The one line the shell prints to stderr for a refused start: the error's class only (its
 * message can carry a path or file text, V01-R13), except the fixed notice of a policy this
 * repository leaves to the deployment, which names no data (I04-H2 ①).
 */
export function startFailureLine(error: unknown): string {
  return error instanceof ScopePolicyNotImplementedError || error instanceof UnknownScopePolicyError
    ? error.message
    : `backend start failed: ${error instanceof Error ? error.name : typeof error}`;
}
