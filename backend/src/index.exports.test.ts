// I05-R1 (the package entry's exports): `@pki/backend` is all a fork sees. It exports what the fork's
// files use (the registration, `runShell`, `runSiteCheck`, the check) and no boot function: a start
// that does not go through `runShell` would take `connectors`, `scopePolicy` and the test replacements
// that skip the registration check and the "no switch to default" rule (I05-R15).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the package entry's exports", () => {
  it("are exactly the ones the fork's files use", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "checkSiteRegistration",
      "publicSite",
      "runShell",
      "runSiteCheck",
    ]);
  });

  it("hold no boot function and no option type that widens one", () => {
    const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/bootBackend|BootOptions|from "\.\/boot\.ts"/);
    expect(Object.keys(entry)).not.toContain("bootBackend");
  });

  // I05-T03 review D3: `startServer` is the API layer's assembly function. It skips the registration check,
  // the ledger re-apply and the policy resolution, and nothing a fork writes needs it, so the entry does not hold it.
  it("hold neither the server's start function nor its option types", () => {
    const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/startServer|ServerOptions|RunningServer|from "\.\/server\.ts"/);
    expect(Object.keys(entry)).not.toContain("startServer");
  });
});
