// V01-C2 `preload.surface`: what the page can reach of the shell is exactly the
// spec's list ("API와 preload"): the session, secret store/check/delete (no read-back),
// and opening an external link.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchShell } from "./launch.ts";

const SPEC_FUNCTIONS = [
  "deleteSecret",
  "getSession",
  "hasSecret",
  "openExternal",
  "pickLocation",
  "revealSource",
  "setSecret",
];

test("the page sees only the spec's preload functions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pki-surface-"));
  const { app, window } = await launchShell({ userData: join(dir, "u"), dataDir: join(dir, "d") });
  try {
    const surface = await window.evaluate(() => {
      const pki = (window as unknown as { pki: Record<string, unknown> }).pki;
      return {
        names: Object.keys(pki).sort(),
        types: Object.values(pki).map((v) => typeof v),
        frozen: Object.isFrozen(pki),
        // Shell globals other than window.pki that a preload could have leaked.
        extra: ["ipcRenderer", "electron", "require", "process", "module", "Buffer"].filter(
          (name) => name in window,
        ),
      };
    });
    expect(surface.names).toEqual(SPEC_FUNCTIONS);
    expect(surface.types).toEqual(SPEC_FUNCTIONS.map(() => "function"));
    expect(surface.frozen).toBe(true);
    expect(surface.extra).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
