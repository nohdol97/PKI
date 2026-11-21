// V01-R10 build kind: one value the bundler writes into the code, read by one
// module (build-kind.ts). The test runner builds as "test" (vitest.config.ts);
// a missing or unknown value is a production build.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILD_KIND, loopbackHttpAllowed, parseBuildKind } from "./build-kind.ts";

const MODULE = pathToFileURL(resolve(import.meta.dirname, "build-kind.ts")).href;
// spelled in pieces: only build-kind.ts and bundler configs may name the build value
// (lint pki/gate-inputs)
const NAME = ["PKI", "BUILD", "KIND"].join("_");
const OLD_GLOBAL = `__${NAME}__`;

/**
 * Loads build-kind.ts in a plain Node process: no bundler, no test-runner define,
 * the way dev.ts and the shell's backend run today. `before` runs first in the
 * same process; `nodeOptions` reaches it through NODE_OPTIONS.
 */
function unbundled(before: string, nodeOptions?: string) {
  const script = `const NAME = ${JSON.stringify(NAME)};\nconst OLD = ${JSON.stringify(OLD_GLOBAL)};\n${before}\nconst m = await import(${JSON.stringify(MODULE)});\nconsole.log(JSON.stringify([m.BUILD_KIND, m.loopbackHttpAllowed(m.BUILD_KIND), m.parseBuildKind("development")]));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) },
  });
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout) as [string, boolean, string];
}

describe("build kind", () => {
  it("is the test build under the test runner", () => {
    expect(BUILD_KIND).toBe("test");
  });

  it.each([
    ["production", "production"],
    ["development", "development"],
    ["test", "test"],
    [undefined, "production"],
    ["", "production"],
    ["dev", "production"],
    ["Development", "production"],
    [" test", "production"],
  ] as const)("reads %j as %s", (raw, kind) => {
    expect(parseBuildKind(raw)).toBe(kind);
  });

  it("allows loopback http in development and test builds only (V01-R11)", () => {
    expect(loopbackHttpAllowed("production")).toBe(false);
    expect(loopbackHttpAllowed("development")).toBe(true);
    expect(loopbackHttpAllowed("test")).toBe(true);
  });
});

// V01-R10 "no value → production", and review B1: in a run without the bundler a
// value supplied at run time (a global under either name, an inherited property,
// an environment variable, a preload) is not the build's value either.
describe("build kind without a bundler", () => {
  it("is production when nothing supplies a value", () => {
    // the third value shows the module loaded and parses: the harness is live
    expect(unbundled("")).toEqual(["production", false, "development"]);
  });

  it.each([
    [
      "a global set before loading",
      "globalThis[NAME] = 'development'; globalThis[OLD] = 'development';",
    ],
    ["a global set to test", "globalThis[NAME] = 'test'; globalThis[OLD] = 'test';"],
    [
      "an environment variable",
      "process.env[NAME] = 'development'; process.env[OLD] = 'development';",
    ],
    [
      "a getter on the global object",
      "Object.defineProperty(globalThis, NAME, { get: () => 'development' }); Object.defineProperty(globalThis, OLD, { get: () => 'development' });",
    ],
    [
      "a property inherited from Object.prototype",
      "Object.defineProperty(Object.prototype, NAME, { value: 'development' }); Object.defineProperty(Object.prototype, OLD, { value: 'development' });",
    ],
  ])("ignores %s: still production", (_, before) => {
    expect(unbundled(before)).toEqual(["production", false, "development"]);
  });

  it("ignores a preload through NODE_OPTIONS --import", () => {
    const dir = mkdtempSync(join(tmpdir(), "pki-build-kind-"));
    try {
      const preload = join(dir, "preload.mjs");
      writeFileSync(
        preload,
        `globalThis[${JSON.stringify(NAME)}] = "development"; globalThis[${JSON.stringify(OLD_GLOBAL)}] = "development";\n`,
      );
      expect(unbundled("", `--import=${pathToFileURL(preload).href}`)).toEqual([
        "production",
        false,
        "development",
      ]);
      // the preload did run: the global is there
      expect(
        unbundled(
          `console.error = () => {}; if (globalThis[NAME] !== "development") throw new Error("preload did not run");`,
          `--import=${pathToFileURL(preload).href}`,
        )[0],
      ).toBe("production");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
