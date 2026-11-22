// `pnpm --filter @pki/backend site-check <kind>` (V01-R18, I01-R1, I05-R19): the public command, with the
// empty registration. A deployment fork has its own in its composition package (site/composition/src/site-check.ts);
// when this repository has that package this command points at it instead of checking the placeholders.
import { resolve } from "node:path";
import { publicSiteCheck } from "./site-check-main.ts";

await publicSiteCheck(resolve(import.meta.dirname, "../.."), process.argv.slice(2));
