// I05-T03 (I05-R7, security review F2): the kinds the Broker trusts as synthetic are readable for a
// test as a frozen copy; nothing an importer holds can add a kind to the trusted set.
import { describe, expect, it } from "vitest";
import * as providers from "./index.ts";
import { SYNTHETIC_CONNECTOR_KIND_LIST } from "./index.ts";

describe("SYNTHETIC_CONNECTOR_KIND_LIST", () => {
  it("is a frozen array, not the Broker's own set", () => {
    expect(Array.isArray(SYNTHETIC_CONNECTOR_KIND_LIST)).toBe(true);
    expect(Object.isFrozen(SYNTHETIC_CONNECTOR_KIND_LIST)).toBe(true);
    expect(SYNTHETIC_CONNECTOR_KIND_LIST.length).toBeGreaterThan(0);
  });

  it("does not export the Broker's own set", () => {
    expect(Object.keys(providers)).not.toContain("SYNTHETIC_CONNECTOR_KINDS");
  });

  it("cannot be used to add a trusted kind", () => {
    const before = [...SYNTHETIC_CONNECTOR_KIND_LIST];
    expect(() => (SYNTHETIC_CONNECTOR_KIND_LIST as string[]).push("acme")).toThrow(TypeError);
    expect(() =>
      (SYNTHETIC_CONNECTOR_KIND_LIST as unknown as { add: (k: string) => void }).add("acme"),
    ).toThrow();
    expect([...SYNTHETIC_CONNECTOR_KIND_LIST]).toEqual(before);
  });
});
