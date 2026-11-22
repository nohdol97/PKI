// The public shell entry (V01-R4, I05-R1): the Electron shell starts this file as a utility process.
// It hands the empty registration to the shell's body (shell-main.ts); a deployment fork starts its own
// entry in its composition package, which hands its registration to the same function.
import { runShell } from "./shell-main.ts";
import { publicSite } from "./site-registration.ts";

await runShell(publicSite);
