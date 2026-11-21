// V01-R10 build kind: one value the bundler writes into the code, read by one
// module (build-kind.ts). The test runner builds as "test" (vitest.config.ts);
// a missing or unknown value is a production build.
import { describe, expect, it } from "vitest";
import { BUILD_KIND, loopbackHttpAllowed, parseBuildKind } from "./build-kind.ts";

describe("build kind", () => {
  it("is the test build under the test runner", () => {
    expect(BUILD_KIND).toBe("test");
  });

  it.each([
    ["production", "production"],
    ["development", "development"],
    ["test", "test"],
    [undefined, "production"],
    ["", "production"],
    ["dev", "production"],
    ["Development", "production"],
    [" test", "production"],
  ] as const)("reads %j as %s", (raw, kind) => {
    expect(parseBuildKind(raw)).toBe(kind);
  });

  it("allows loopback http in development and test builds only (V01-R11)", () => {
    expect(loopbackHttpAllowed("production")).toBe(false);
    expect(loopbackHttpAllowed("development")).toBe(true);
    expect(loopbackHttpAllowed("test")).toBe(true);
  });
});
