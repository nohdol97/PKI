// I04-R7: what the backend tells the shell about a refused start is a fixed class.
import { LedgerReapplyError } from "@pki/knowledge-engine";
import { IdentityKeyMissingError, LedgerUnavailableError } from "@pki/storage";
import { describe, expect, it } from "vitest";
import { SiteRegistrationInvalidError } from "./site-registration.ts";
import { startFailureLine, startFailureReport } from "./start-failure.ts";

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
  it("names a ledger that could not be opened or created, never the cause", () => {
    expect(
      startFailureReport(new LedgerUnavailableError(new Error("/home/u/ledger EACCES"))),
    ).toEqual({
      type: "failed",
      reason: "ledger-unavailable",
    });
  });
  it("names a registration that stops the start by one fixed reason; the codes and counts go to the stderr line only (I05-R9)", () => {
    const error = new SiteRegistrationInvalidError([
      { code: "instance-kind-reserved", count: 2 },
      { code: "instance-id-reserved", count: 1 },
    ]);
    expect(startFailureReport(error)).toEqual({
      type: "failed",
      reason: "site-registration-invalid",
    });
    expect(startFailureLine(error)).toBe(
      "backend start failed: site-registration-invalid instance-kind-reserved=2 instance-id-reserved=1",
    );
    // the error's own message carries the same codes and counts, nothing the registration wrote
    expect(error.message).toBe(
      "site-registration-invalid instance-kind-reserved=2 instance-id-reserved=1",
    );
  });
  it("is the bare failure for any other error or none", () => {
    expect(startFailureReport(new Error("/home/u/secret.db"))).toEqual({ type: "failed" });
    expect(startFailureReport(undefined)).toEqual({ type: "failed" });
  });
});

describe("startFailureLine prints no name a thrown value controls (security review W4)", () => {
  it("names a known class and anything else as `other`", () => {
    class Crafted extends Error {
      override name = "AKIA-looking-secret-name";
    }
    expect(startFailureLine(new Crafted("x"))).toBe("backend start failed: other");
    expect(startFailureLine(new TypeError("x"))).toBe("backend start failed: TypeError");
    expect(startFailureLine("a string")).toBe("backend start failed: string");
  });

  it("survives a value whose name getter throws or whose prototype trap throws", () => {
    const getter = Object.assign(new Error("x"), {});
    Object.defineProperty(getter, "name", {
      get() {
        throw new Error("boom");
      },
    });
    expect(startFailureLine(getter)).toBe("backend start failed: other");
    const proxy = new Proxy(new Error("x"), {
      getPrototypeOf() {
        throw new Error("boom");
      },
    });
    expect(startFailureLine(proxy)).toBe("backend start failed: other");
  });

  // security review T03 D5: the report that goes to the shell is built from the same `instanceof` chain, so a
  // trap that throws there must not stop the failure message (nothing would be posted and the process would die
  // on an unhandled rejection that prints the thrown error)
  it("builds the failure report from a hostile value too: no reason, never a throw", () => {
    const getter = Object.assign(new Error("x"), {});
    Object.defineProperty(getter, "name", {
      get() {
        throw new Error("boom");
      },
    });
    expect(startFailureReport(getter)).toEqual({ type: "failed" });
    const proxy = new Proxy(new Error("x"), {
      getPrototypeOf() {
        throw new Error("boom");
      },
    });
    expect(startFailureReport(proxy)).toEqual({ type: "failed" });
    const hostileSeq = Object.assign(Object.create(LedgerReapplyError.prototype) as Error, {});
    Object.defineProperty(hostileSeq, "seq", {
      get() {
        throw new Error("boom");
      },
    });
    expect(startFailureReport(hostileSeq)).toEqual({ type: "failed" });
  });

  it("keeps the name of the project's own classes that carry a reason", () => {
    expect(startFailureLine(new IdentityKeyMissingError())).toBe(
      "backend start failed: IdentityKeyMissingError",
    );
  });
});
