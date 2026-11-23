// The scope policy name the shell starts the backend with (I04-R14, I05-R15, S21): the production
// build gives no name, so the backend's registration decides (and the environment cannot change that);
// a source run reads the environment.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBackendProcess, type BackendChild, type ForkBackend } from "./backend-process.ts";
import { scopePolicyName as sourceRun } from "./layout.ts";
import * as productionLayout from "./layout.production.ts";

const production = productionLayout.scopePolicyName as (
  env?: Record<string, string>,
) => string | undefined;

const child = (): BackendChild => {
  let onMessage: (message: unknown) => void = () => undefined;
  return {
    pid: 1,
    postMessage: () => queueMicrotask(() => onMessage({ type: "ready", port: 1234 })),
    on: (_event, listener) => void (onMessage = listener),
    once: () => undefined,
    kill: () => true,
  };
};
async function argsFor(name: string | undefined) {
  const seen: string[][] = [];
  const fork: ForkBackend = (_entry, args) => {
    seen.push(args);
    return child();
  };
  await startBackendProcess({
    fork,
    entry: "x",
    origin: "app://pki",
    userData: "/u",
    scopePolicy: name,
  });
  return seen[0];
}

describe("the production build gives the backend no policy name (I05-R15, I05-C13)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("gives no name, whatever the process environment holds", () => {
    vi.stubEnv("PKI_SCOPE_POLICY", "site");
    expect(production()).toBeUndefined();
    expect(production({ PKI_SCOPE_POLICY: "site" })).toBeUndefined();
    expect(production({})).toBeUndefined();
  });

  it("has no SCOPE_POLICY constant to edit: the policy is the registration's", () => {
    expect(Object.keys(productionLayout)).not.toContain("SCOPE_POLICY");
  });

  it("starts the backend with no --scope-policy switch", async () => {
    expect(await argsFor(production({ PKI_SCOPE_POLICY: "site" }))).toEqual([
      "--origin",
      "app://pki",
      "--user-data",
      "/u",
    ]);
  });
});

describe("a source run reads the environment", () => {
  it("takes PKI_SCOPE_POLICY, none when unset, and hands it to the backend", async () => {
    expect(sourceRun({ PKI_SCOPE_POLICY: "site" })).toBe("site");
    expect(sourceRun({})).toBeUndefined();
    expect(await argsFor(sourceRun({ PKI_SCOPE_POLICY: "site" }))).toEqual([
      "--origin",
      "app://pki",
      "--user-data",
      "/u",
      "--scope-policy",
      "site",
    ]);
  });
});

describe("the shell entry takes the name from the layout (main.ts)", () => {
  // main.ts is the Electron entry and cannot be started here: this reads its text, so a start that
  // leaves the policy out, or reads the environment instead of the layout, fails (the type of
  // `BackendOptions.scopePolicy` is required as well, which typecheck holds)
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  it("passes scopePolicyName(process.env) and never reads PKI_SCOPE_POLICY itself", () => {
    expect(main).toContain("scopePolicy: scopePolicyName(process.env)");
    expect(main).not.toContain("PKI_SCOPE_POLICY");
  });
});
