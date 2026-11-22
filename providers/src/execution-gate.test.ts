// V01-R10 execution conditions (ARCHITECTURE 3.1), decided by the gate alone: one
// unit case per branch. The end-to-end cases through the API, the Broker and the
// canonical DB are backend/src/cli-gate.test.ts.
import { migrate, writeSetting } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import type { ExecutionInput } from "./broker.ts";
import { CLI_PROFILES } from "./cli-profiles.ts";
import {
  CLI_BACKGROUND_SETTING,
  createExecutionGate,
  testBuildDecision,
  readCliBackground,
} from "./execution-gate.ts";
import { VERIFIED_CLI_COMBINATIONS } from "./verified-cli.ts";

const OS = platform();
const VERSION = "2.1.3";
const listed = [
  {
    cli: "claude-code",
    version: VERSION,
    os: OS,
    profile: CLI_PROFILES["claude-code"].standard,
    model: "synthetic-model",
    verifiedOn: "2026-12-01",
  },
];

const user: ExecutionInput = {
  providerId: "claude-code",
  transport: "cli",
  taskKind: "connection-test",
  trigger: "user",
  classification: "synthetic",
  malicious: false,
  version: VERSION,
  unverifiedAcknowledged: false,
};

function db() {
  const d = openBetterSqlite3(":memory:");
  migrate(d);
  return d;
}

describe("background setting", () => {
  it("is off by default (V01-C7 cli-background-default)", () => {
    expect(readCliBackground(db())).toBe(false);
  });

  it.each([
    ["on", true],
    ["off", false],
    ["true", false],
    ["ON", false],
    ["", false],
  ])("reads %j as %s", (value, on) => {
    const d = db();
    writeSetting(d, CLI_BACKGROUND_SETTING, value);
    expect(readCliBackground(d)).toBe(on);
  });
});

describe("the test build's pick", () => {
  const pick = { decideAs: "development", verified: listed } as const;

  // honoured in a test build only: createExecutionGate enters it when the build kind
  // is "test", which the bundler folds away from any other build (V01-T15; a
  // production artifact ignoring it is apps/desktop/artifact/artifact.gate.e2e.ts)
  it("is honoured, production when nothing is picked", () => {
    expect(testBuildDecision(pick)).toEqual({ decideAs: "development", verified: listed });
    expect(testBuildDecision(undefined)).toEqual({
      decideAs: "production",
      verified: VERIFIED_CLI_COMBINATIONS,
    });
    expect(testBuildDecision({ verified: [] })).toEqual({ decideAs: "production", verified: [] });
  });
});

describe("execution gate", () => {
  it("does not judge an HTTP Provider", () => {
    const gate = createExecutionGate({ db: db() });
    expect(
      gate.decide({
        ...user,
        providerId: "openai-compatible",
        transport: "http",
        version: undefined,
      }),
    ).toEqual({ run: true });
  });

  it("decides as a production build when the test build picks nothing", () => {
    const gate = createExecutionGate({ db: db(), testBuild: { verified: [] } });
    expect(gate.decide({ ...user, unverifiedAcknowledged: true })).toEqual({
      run: false,
      reason: "cli-not-verified",
    });
  });

  it("runs a listed combination with its profile, marked verified", () => {
    const gate = createExecutionGate({ db: db(), testBuild: { verified: listed } });
    expect(gate.decide(user)).toEqual({
      run: true,
      cli: {
        profile: CLI_PROFILES["claude-code"].standard,
        isolation: "verified",
        model: "synthetic-model",
      },
    });
  });

  it("runs a listed background call only while the setting is on", () => {
    const d = db();
    const gate = createExecutionGate({ db: d, testBuild: { verified: listed } });
    const background = { ...user, trigger: "background" } as const;
    expect(gate.decide(background)).toEqual({ run: false, reason: "cli-background-off" });
    writeSetting(d, CLI_BACKGROUND_SETTING, "on");
    expect(gate.decide(background)).toMatchObject({ run: true });
  });

  it("gives the development exception the minimal profile, marked unverified", () => {
    const gate = createExecutionGate({ db: db(), testBuild: { decideAs: "development" } });
    expect(gate.decide({ ...user, unverifiedAcknowledged: true })).toEqual({
      run: true,
      cli: { profile: CLI_PROFILES["claude-code"].minimal, isolation: "unverified" },
    });
  });

  it.each([
    ["a background call", { trigger: "background" }, "unverified-background"],
    ["general input", { classification: "general" }, "unverified-not-synthetic"],
    ["a malicious variant", { malicious: true }, "unverified-malicious"],
    ["no acknowledgement", { unverifiedAcknowledged: false }, "unverified-ack-required"],
  ] as const)("blocks the development exception for %s", (_, change, reason) => {
    const gate = createExecutionGate({ db: db(), testBuild: { decideAs: "development" } });
    expect(gate.decide({ ...user, unverifiedAcknowledged: true, ...change })).toEqual({
      run: false,
      reason,
    });
  });

  it("blocks a CLI the code has no argument profile for", () => {
    const gate = createExecutionGate({ db: db(), testBuild: { decideAs: "development" } });
    expect(
      gate.decide({ ...user, providerId: "local-model", unverifiedAcknowledged: true }),
    ).toEqual({ run: false, reason: "cli-unknown" });
  });

  it.each([
    ["another version", { version: "2.1.4" }],
    ["an unreadable version", { version: undefined }],
    ["an unparsable version", { version: "2.1.3 (build 7)" }],
  ] as const)("treats %s as not listed", (_, change) => {
    const gate = createExecutionGate({ db: db(), testBuild: { verified: listed } });
    expect(gate.decide({ ...user, ...change })).toEqual({ run: false, reason: "cli-not-verified" });
  });

  it.each([
    ["another OS", { os: OS === "win32" ? "linux" : "win32" }],
    ["another profile", { profile: CLI_PROFILES["claude-code"].minimal }],
    ["another CLI", { cli: "codex", profile: CLI_PROFILES.codex.standard }],
  ] as const)("treats an entry for %s as not matching", (_, change) => {
    const gate = createExecutionGate({
      db: db(),
      testBuild: { verified: [{ ...listed[0], ...change }] },
    });
    expect(gate.decide(user)).toEqual({ run: false, reason: "cli-not-verified" });
  });
});
