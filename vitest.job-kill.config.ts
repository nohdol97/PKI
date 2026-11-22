// The kill tests' child process (I03-R24, backend/src/job-kill.test.ts): a test
// build like the suite's, since it takes the build value's definition from
// vitest.config.ts as it is, running backend/src/job-kill.child.ts alone on one
// thread, so the backend is one process.
import { defineConfig } from "vitest/config";
import suite from "./vitest.config.ts";

export default defineConfig({
  define: { ...suite.define },
  test: {
    include: ["backend/src/job-kill.child.ts"],
    pool: "threads",
    maxWorkers: 1,
    watch: false,
    // the backend runs until the test kills it; a child left behind ends on its own
    testTimeout: 120_000,
  },
});
