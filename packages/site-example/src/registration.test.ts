// I05-C1 ① and C6 ① `site.example-registration` (I05-R20): what a fork's own `registration.test.ts` does
// (site/composition/src/registration.test.ts): the registration passes the product's check with no violation.
import { checkSiteRegistration } from "@pki/backend";
import { describe, expect, it } from "vitest";
import { registration } from "./registration.ts";

describe("site.example-registration", () => {
  it("has no violation: the check returns an empty list", () => {
    expect(checkSiteRegistration(registration)).toEqual([]);
  });

  it("registers one collector kind and one instance of it", () => {
    expect(Object.keys(registration.connectorKinds ?? {})).toEqual(["connector-example"]);
    expect(registration.connectorInstances).toEqual([
      expect.objectContaining({ id: "example-notes", kind: "connector-example" }),
    ]);
  });

  it("makes a new collector object each time, of the kind's own name", () => {
    const make = registration.connectorKinds?.["connector-example"];
    const [a, b] = [make?.(), make?.()];
    expect(a).not.toBe(b);
    expect(a?.manifest.type).toBe("connector-example");
  });
});
