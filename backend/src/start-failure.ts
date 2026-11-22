// What the backend tells the shell about a refused start (I04-R7): a fixed class,
// never the error's message (it can carry a path or file text; V01-R13).
import { LedgerReapplyError } from "@pki/knowledge-engine";
import { IdentityKeyMissingError } from "@pki/storage";

export type StartFailureReport =
  | { type: "failed"; reason?: "identity-key-missing" }
  /** `line`: the ledger line number (never its content) whose re-apply failed; the start stays closed. */
  | { type: "failed"; reason: "ledger-reapply-failed"; line: number };

export function startFailureReport(error?: unknown): StartFailureReport {
  if (error instanceof LedgerReapplyError) {
    return { type: "failed", reason: "ledger-reapply-failed", line: error.seq };
  }
  return error instanceof IdentityKeyMissingError
    ? { type: "failed", reason: "identity-key-missing" }
    : { type: "failed" };
}
