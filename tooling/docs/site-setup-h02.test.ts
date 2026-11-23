// H02A-C8 `docs.h02`: site-setup carries the three deployment-fork items of the H02 common scope
// once each, and names the shell switch, the SBOM file and the shared channel's reason in the
// same letters as the code's constants. A separate file from the other site-setup tests.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SBOM_FILE } from "../../apps/desktop/build/paths.ts";
import { UNINSTALL_SWITCH } from "../../apps/desktop/src/data-removal.ts";
import { UNAVAILABLE } from "../../apps/desktop/src/update.ts";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");
const site = read("docs/site-setup.md");

describe("docs.h02 (H02A-C8)", () => {
  it("carries S46, S47 and S48 once each, and the update sentence is current", () => {
    for (const n of ["S46", "S47", "S48"]) {
      expect([...site.matchAll(new RegExp(`^- \\[[ x]\\] \\*\\*${n} `, "gm"))], n).toHaveLength(1);
    }
    expect(site).not.toContain("자동 업데이트 주소**: 아직 없다");
  });

  it("names the switch, the SBOM file and the shared channel's reason as the code spells them", () => {
    expect(site).toContain(`--${UNINSTALL_SWITCH}`);
    expect(site).toContain(basename(SBOM_FILE));
    expect(basename(SBOM_FILE)).toBe("sbom.cdx.json");
    expect(site).toContain(UNAVAILABLE);
  });

  it("the docs index lists the H02 spec", () => {
    expect(read("docs/README.md")).toContain("specs/2026-11-24-H02-common.md");
  });
});
