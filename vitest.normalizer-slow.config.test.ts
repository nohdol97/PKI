// I02B-C17, C49: the slow normalizer tests run from their own configuration and `pnpm test` does not run
// them (each holds a 60 s limit or repeats a 30-run loop and some take over a gigabyte). Two facts keep
// that true: the default configuration picks up `*.test.ts(x)` only, and the slow files are named
// `*.slow.ts` and picked up by the slow configuration alone, one at a time.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import slow from "./vitest.normalizer-slow.config.ts";
import suite from "./vitest.config.ts";

const FOLDER = join(import.meta.dirname, "packages/document-normalize/src");

describe("the slow normalizer tests' configuration", () => {
  it("picks up the `.slow.ts` files of the package, runs them one at a time, and has the suite's build kind", () => {
    expect(slow.test?.include).toEqual(["packages/document-normalize/src/*.slow.ts"]);
    expect(slow.test?.maxWorkers).toBe(1);
    expect(slow.test?.fileParallelism).toBe(false);
    expect(slow.define).toEqual(suite.define);
  });

  it("the slow files exist, and the default configuration cannot pick them up", () => {
    const slowFiles = readdirSync(FOLDER).filter((name) => name.endsWith(".slow.ts"));
    expect(slowFiles.sort()).toEqual(["reproduction-inputs.slow.ts", "trigger-repeat.slow.ts"]);
    expect(suite.test?.include).toEqual(["**/*.test.{ts,tsx}"]);
    for (const name of slowFiles) expect(name).not.toMatch(/\.test\.tsx?$/);
  });
});
