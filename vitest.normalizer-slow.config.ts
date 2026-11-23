// The slow normalizer tests (I02B-C17, C49): `packages/document-normalize/src/*.slow.ts`, which `pnpm test`
// does not run. Each takes minutes (a worker that runs 60 s into its time limit, a trigger input
// repeated 30 times) and some hold a gigabyte or more, so they run one at a time in a thread of their
// own, from a separate command (the pattern of vitest.job-kill.config.ts):
//   pnpm exec vitest run --config vitest.normalizer-slow.config.ts
import { defineConfig } from "vitest/config";
import suite from "./vitest.config.ts";

export default defineConfig({
  define: { ...suite.define },
  test: {
    include: ["packages/document-normalize/src/*.slow.ts"],
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
    watch: false,
    testTimeout: 3_600_000,
  },
});
