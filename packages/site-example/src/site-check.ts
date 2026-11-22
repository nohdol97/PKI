// The example's `site-check` entry (I05-R19, R21): a fork's `site/composition/src/site-check.ts` has this
// shape. `pnpm --filter @pki/site-example site-check <kind>` initializes one kind of this registration.
import { runSiteCheck } from "@pki/backend";
import { registration } from "./registration.ts";

await runSiteCheck(registration, process.argv.slice(2));
