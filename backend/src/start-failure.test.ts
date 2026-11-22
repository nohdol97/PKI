// I04-R7: what the backend tells the shell about a refused start is a fixed class.
import { IdentityKeyMissingError } from "@pki/storage";
import { describe, expect, it } from "vitest";
import { startFailureReport } from "./start-failure.ts";

describe("startFailureReport", () => {
  it("names the missing identity key and nothing of the error", () => {
    expect(startFailureReport(new IdentityKeyMissingError())).toEqual({
      type: "failed",
      reason: "identity-key-missing",
    });
  });
  it("is the bare failure for any other error or none", () => {
    expect(startFailureReport(new Error("/home/u/secret.db"))).toEqual({ type: "failed" });
    expect(startFailureReport(undefined)).toEqual({ type: "failed" });
  });
});
