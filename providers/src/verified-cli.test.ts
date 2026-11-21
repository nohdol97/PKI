// V01-R10 verified CLI combinations: a read-only build resource. The public
// repository's list is empty; an entry is one CLI, one exact version, one OS, one
// argument profile name, the model R02 ran and the date R02 verified it. Nothing can add to it at
// run time (the API and setting cases: backend/src/cli-list.readonly.test.ts).
import { describe, expect, it } from "vitest";
import listed from "./verified-cli-combinations.json" with { type: "json" };
import { CLI_PROFILES } from "./cli-profiles.ts";
import { isExactVersion, parseVerifiedList, VERIFIED_CLI_COMBINATIONS } from "./verified-cli.ts";

const entry = {
  cli: "claude-code",
  version: "2.1.3",
  os: "win32",
  profile: CLI_PROFILES["claude-code"].standard,
  model: "synthetic-model",
  verifiedOn: "2026-12-01",
} as const;

describe("verified CLI combinations", () => {
  it("is empty in the public repository", () => {
    expect(listed).toEqual([]);
    expect(VERIFIED_CLI_COMBINATIONS).toEqual([]);
  });

  it("cannot be extended or changed at run time", () => {
    expect(Object.isFrozen(VERIFIED_CLI_COMBINATIONS)).toBe(true);
    expect(() => (VERIFIED_CLI_COMBINATIONS as unknown as unknown[]).push(entry)).toThrow(
      TypeError,
    );
    // the imported JSON module object is not what the gate reads
    (listed as unknown[]).push(entry);
    try {
      expect(VERIFIED_CLI_COMBINATIONS).toEqual([]);
    } finally {
      (listed as unknown[]).pop();
    }
  });

  it("freezes every entry it parses", () => {
    const [parsed] = parseVerifiedList([entry]);
    expect(parsed).toEqual(entry);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ["a version range", { ...entry, version: "^2.1.3" }],
    ["a partial version", { ...entry, version: "2.1" }],
    ["an unknown CLI", { ...entry, cli: "openai-compatible" }],
    ["an unknown OS", { ...entry, os: "windows" }],
    ["a profile the code does not define", { ...entry, profile: "anything" }],
    ["a date that is not a date", { ...entry, verifiedOn: "yesterday" }],
    ["an extra field", { ...entry, args: ["--yolo"] }],
    [
      "no model (R02 verdicts are model-scoped)",
      Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "model")),
    ],
    ["an empty model", { ...entry, model: "" }],
    ["a model read as an option", { ...entry, model: "--yolo" }],
    ["a model with spaces", { ...entry, model: "a model" }],
    [
      "a missing field",
      { cli: "codex", version: "1.0.0", os: "linux", profile: CLI_PROFILES.codex.standard },
    ],
  ])("refuses %s (the backend does not start)", (_, bad) => {
    expect(() => parseVerifiedList([bad])).toThrow();
  });

  it.each([
    ["2.1.3", true],
    ["0.0.1", true],
    ["10.20.30-beta.1", true],
    ["1.2.3+build.5", true],
    ["2.1", false],
    ["v2.1.3", false],
    [" 2.1.3", false],
    ["2.1.3\n", false],
    ["02.1.3", false],
    ["fake-1", false],
    ["", false],
    [undefined, false],
  ] as const)("isExactVersion(%j) is %s", (version, ok) => {
    expect(isExactVersion(version)).toBe(ok);
  });
});
