// I04-R7: what the backend tells the shell about a refused start is a fixed class.
import { LedgerReapplyError } from "@pki/knowledge-engine";
import { IdentityKeyMissingError } from "@pki/storage";
import { describe, expect, it } from "vitest";
import { startFailureReport } from "./start-failure.ts";

describe("start.identity-key-text: startFailureReport", () => {
  it("names the missing identity key and nothing of the error", () => {
    expect(startFailureReport(new IdentityKeyMissingError())).toEqual({
      type: "failed",
      reason: "identity-key-missing",
    });
  });
  it("names a ledger line that could not be re-applied by its number only, never the cause", () => {
    const error = new LedgerReapplyError(7, new Error("/home/u/secret.db FOREIGN KEY"));
    expect(startFailureReport(error)).toEqual({
      type: "failed",
      reason: "ledger-reapply-failed",
      line: 7,
    });
  });
  it("is the bare failure for any other error or none", () => {
    expect(startFailureReport(new Error("/home/u/secret.db"))).toEqual({ type: "failed" });
    expect(startFailureReport(undefined)).toEqual({ type: "failed" });
  });
});
