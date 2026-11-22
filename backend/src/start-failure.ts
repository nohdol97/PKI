// What the backend tells the shell about a refused start (I04-R7): a fixed class,
// never the error's message (it can carry a path or file text; V01-R13).
import { IdentityKeyMissingError } from "@pki/storage";

export type StartFailureReport = { type: "failed"; reason?: "identity-key-missing" };

export function startFailureReport(error?: unknown): StartFailureReport {
  return error instanceof IdentityKeyMissingError
    ? { type: "failed", reason: "identity-key-missing" }
    : { type: "failed" };
}
