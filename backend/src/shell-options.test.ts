// V01-T15: the shell entry's command line. A source run (development and tests)
// takes the data-dir and fixtures switches; the production build bundles
// shell-options.production.ts in its place (apps/desktop/build/bundle.ts), which
// takes the screens' origin only and refuses anything else, so the artifact has
// no test Connector and no switch to move the canonical DB.
import { describe, expect, it } from "vitest";
import { connectorKinds } from "./composition.ts";
import { shellOptions as production } from "./shell-options.production.ts";
import { shellOptions as source } from "./shell-options.ts";

describe("source run", () => {
  it("takes the origins, the data directory and the test Connector's fixtures", () => {
    const options = source([
      "--origin",
      "app://pki",
      "--data-dir",
      "/synthetic/data",
      "--fixtures",
      "/synthetic/f.jsonl",
    ]);
    expect(options.origins).toEqual(["app://pki"]);
    expect(options.dataDir).toBe("/synthetic/data");
    expect(Object.keys(options.connectors?.kinds ?? {})).toContain("test-fixtures");
    expect(options.connectors?.instances[0]?.config).toEqual({ file: "/synthetic/f.jsonl" });
  });

  it("without fixtures, binds the product's Connectors", () => {
    const options = source(["--origin", "app://pki"]);
    expect(options.dataDir).toBeUndefined();
    expect(options.connectors).toBeUndefined();
  });
});

describe("production build", () => {
  it("takes the origins only", () => {
    expect(production(["--origin", "app://pki"])).toEqual({ origins: ["app://pki"] });
    expect(connectorKinds).not.toHaveProperty("test-fixtures");
  });

  it("maps --user-data to userData (I02B-R48)", () => {
    expect(production(["--origin", "app://pki", "--user-data", "/u"])).toEqual({
      origins: ["app://pki"],
      userData: "/u",
    });
  });

  it.each([
    ["--data-dir", "/synthetic/data"],
    ["--fixtures", "/synthetic/f.jsonl"],
    ["--scope-policy", "default"],
  ])("refuses %s", (flag, value) => {
    expect(() => production(["--origin", "app://pki", flag, value])).toThrow();
  });
});
