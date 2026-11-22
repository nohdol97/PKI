// I05-T03 (I05-R15, I05-C13) on the real bootBackend: the policy a start uses is the one the name and
// the registration decide (the table's rows), and it is the one the registry is built with. The
// registry is the policy's only consumer at start (the Broker, the runner's commit and the status API
// all read the registry's policy), so the composition's `productRegistry` is wrapped to record it.
import { defaultScopePolicy, type ScopePolicy } from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ policies: [] as unknown[] }));
vi.mock("./composition.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./composition.ts")>();
  return {
    ...real,
    productRegistry: (...args: Parameters<typeof real.productRegistry>) => {
      seen.policies.push(args[0].policy);
      return real.productRegistry(...args);
    },
  };
});

const { bootBackend } = await import("./boot.ts");
const { NO_SECRET_STORE } = await import("./secret-sources.ts");
const { ScopePolicyNotImplementedError, UnknownScopePolicyError } =
  await import("./scope-policy.ts");

const TOKEN = "p".repeat(43);
const mine: ScopePolicy = { ...defaultScopePolicy };

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-site-policy-"));
  seen.policies = [];
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const boot = async (scopePolicy: string | undefined, site?: { scopePolicy?: ScopePolicy }) =>
  (booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    ...(scopePolicy === undefined ? {} : { scopePolicy }),
    ...(site ? { site } : {}),
  }));

describe("scope-policy at boot: the registry is built with the policy the table names (I05-R15)", () => {
  it("no name, a registered policy: the registration's", async () => {
    await boot(undefined, { scopePolicy: mine });
    expect(seen.policies).toEqual([mine]);
    expect(seen.policies[0]).toBe(mine);
  });

  it("no name, none registered: the public default", async () => {
    await boot(undefined, {});
    expect(seen.policies[0]).toBe(defaultScopePolicy);
  });

  it("`default`, whatever is registered: the public default", async () => {
    await boot("default", { scopePolicy: mine });
    expect(seen.policies[0]).toBe(defaultScopePolicy);
  });

  it("`site` with a registered policy: the registration's", async () => {
    await boot("site", { scopePolicy: mine });
    expect(seen.policies[0]).toBe(mine);
  });

  it("`site` with none registered stops the start with the follow-up notice, before any file is opened", async () => {
    await expect(boot("site", {})).rejects.toThrow(ScopePolicyNotImplementedError);
    expect(seen.policies).toEqual([]);
  });

  it("any other name stops the start, a registered policy or not", async () => {
    await expect(boot("strict", { scopePolicy: mine })).rejects.toThrow(UnknownScopePolicyError);
    await expect(boot("", { scopePolicy: mine })).rejects.toThrow(UnknownScopePolicyError);
    expect(seen.policies).toEqual([]);
  });
});
