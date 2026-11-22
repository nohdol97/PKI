// The example's backend entry (I05-R1): a fork's `site/composition/src/shell.ts` has this shape. The build
// picks it in place of `backend/src/shell.ts` when the composition package exists (I05-R2).
import { runShell } from "@pki/backend";
import { registration } from "./registration.ts";

await runShell(registration);
