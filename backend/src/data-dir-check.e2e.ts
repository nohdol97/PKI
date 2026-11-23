// Test-build-only check (I02B-T03c, I02B-C24): after an E2E has stopped its backend,
//   node backend/src/data-dir-check.e2e.ts --data-dir DIR
// prints what DIR holds that no registered derivative kind or operational entry accounts for, one per line,
// and exits 1 if there is any (the check of derivative-coverage.ts, over the product's registry). A script, not
// a test: the web E2E may not import backend paths, and Playwright does not collect it (testIgnore).
import { EmptyVectorIndex } from "@pki/storage/adapters";
import { parseArgs } from "node:util";
import { productEngine, productRegistry } from "./composition.ts";
import { checkDataDirectory } from "./derivative-coverage.ts";

const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
if (!values["data-dir"]) throw new Error("--data-dir is required");
const registry = productRegistry({ engine: productEngine(), vectorIndex: new EmptyVectorIndex() });
const unaccounted = checkDataDirectory(values["data-dir"], registry);
for (const entry of unaccounted) process.stdout.write(`${JSON.stringify(entry)}\n`);
process.exit(unaccounted.length === 0 ? 0 : 1);
