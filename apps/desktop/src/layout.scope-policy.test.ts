// The scope policy name the shell starts the backend with (I04-R14, S21): the production build's
// is a build-time value the environment cannot change; a source run reads the environment.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBackendProcess, type BackendChild, type ForkBackend } from "./backend-process.ts";
import { scopePolicyName as sourceRun } from "./layout.ts";
import { SCOPE_POLICY, scopePolicyName as production } from "./layout.production.ts";

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
  await startBackendProcess({ fork, entry: "x", origin: "app://pki", scopePolicy: name });
  return seen[0];
}

describe("the production build's scope policy is a build-time value", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("ignores the process environment itself", () => {
    vi.stubEnv("PKI_SCOPE_POLICY", "site");
    expect(production()).toBe("default");
  });

  it("is `default` in the public repository and ignores the environment, whatever it holds or lacks", () => {
    expect(SCOPE_POLICY).toBe("default");
    expect((production as (env?: Record<string, string>) => string)()).toBe("default");
    expect(
      (production as (env?: Record<string, string>) => string)({ PKI_SCOPE_POLICY: "site" }),
    ).toBe("default");
  });

  it("reaches the backend as the build-time name even when the environment says site", async () => {
    const name = (production as (env?: Record<string, string>) => string)({
      PKI_SCOPE_POLICY: "site",
    });
    expect(await argsFor(name)).toEqual(["--origin", "app://pki", "--scope-policy", "default"]);
  });
});

describe("a source run reads the environment", () => {
  it("takes PKI_SCOPE_POLICY, none when unset, and hands it to the backend", async () => {
    expect(sourceRun({ PKI_SCOPE_POLICY: "site" })).toBe("site");
    expect(sourceRun({})).toBeUndefined();
    expect(await argsFor(sourceRun({ PKI_SCOPE_POLICY: "site" }))).toEqual([
      "--origin",
      "app://pki",
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
