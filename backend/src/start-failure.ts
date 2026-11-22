// What the backend tells the shell about a refused start (I04-R7): a fixed class,
// never the error's message (it can carry a path or file text; V01-R13).
import { IdentityKeyMissingError } from "@pki/storage";
import { ScopePolicyNotImplementedError } from "./scope-policy.ts";

export type StartFailureReport = { type: "failed"; reason?: "identity-key-missing" };

export function startFailureReport(error?: unknown): StartFailureReport {
  return error instanceof IdentityKeyMissingError
    ? { type: "failed", reason: "identity-key-missing" }
    : { type: "failed" };
}

/**
 * The one line the shell prints to stderr for a refused start: the error's class only (its
 * message can carry a path or file text, V01-R13), except the fixed notice of a policy this
 * repository leaves to the deployment, which names no data (I04-H2 ①).
 */
export function startFailureLine(error: unknown): string {
  return error instanceof ScopePolicyNotImplementedError
    ? error.message
    : `backend start failed: ${error instanceof Error ? error.name : typeof error}`;
}
