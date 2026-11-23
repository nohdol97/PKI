// The measurement runner's test-build backend (H03-C2, backend/src/system-measure.test-support.ts): a test build like
// the suite's, since it takes the build value's definition from vitest.config.ts as it is, running
// backend/src/system-measure.child.test-support.ts alone on one thread, so the backend is one process. Its job lease
// comes from PKI_MEASURE_LEASE_MS, honoured in a test build only.
import { defineConfig } from "vitest/config";
import suite from "./vitest.config.ts";

export default defineConfig({
  define: { ...suite.define },
  test: {
    include: ["backend/src/system-measure.child.test-support.ts"],
    pool: "threads",
    maxWorkers: 1,
    watch: false,
    // the backend runs until the runner kills it; a child left behind ends on its own
    testTimeout: 600_000,
  },
});
