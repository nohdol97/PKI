// H02A-C1: the SBOM the build writes (spec 2026-11-24-H02-common, R1, R2). Small synthetic list.
import { describe, expect, it } from "vitest";
import { completeSbom, type Sbom } from "./sbom.ts";

const component = (group: string | undefined, name: string, version: string) => ({
  type: "library",
  name,
  version,
  ...(group === undefined ? {} : { group }),
  purl: `pkg:npm/${group === undefined ? "" : `${encodeURIComponent(group)}/`}${name}@${version}`,
});
const base = (): Sbom => ({
  bomFormat: "CycloneDX",
  specVersion: "1.7",
  components: [component(undefined, "plain", "1.0.0"), component("@scope", "scoped", "2.0.0")],
});

describe("completeSbom", () => {
  it("H02A-C1: adds Electron at its pinned version and marks the copied and native packages", () => {
    const sbom = completeSbom(base(), {
      electronVersion: "45.4.1",
      runtime: [
        { name: "plain", version: "1.0.0", native: false },
        { name: "@scope/scoped", version: "2.0.0", native: true },
      ],
    });
    const electron = sbom.components.find((c) => c.name === "electron");
    expect(electron).toMatchObject({ version: "45.4.1", purl: "pkg:npm/electron@45.4.1" });
    const marks = (name: string) =>
      sbom.components.find((c) => c.name === name)?.properties?.map((p) => p.name);
    expect(marks("plain")).toEqual(["pki:copied"]);
    expect(marks("scoped")).toEqual(["pki:copied", "pki:native"]);
  });

  it("H02A-C1: a runtime package missing from the list stops the build and is named", () => {
    expect(() =>
      completeSbom(base(), {
        electronVersion: "45.4.1",
        runtime: [{ name: "@scope/absent", version: "3.0.0", native: false }],
      }),
    ).toThrow(/@scope\/absent@3\.0\.0/);
  });
});
