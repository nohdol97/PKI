// The app folder's layout (V01-T15), bundled in place of layout.ts: next to
// main.js, the screens in web/ and the bundled backend in backend/shell.js. No
// switch: the canonical DB is the per-user data directory and there is no test
// Connector. The shell refuses to start with a debugging switch (debugging.ts).
import { fileURLToPath } from "node:url";
import type { Switches } from "./layout.ts";

export const WEB_ROOT = fileURLToPath(new URL("./web/", import.meta.url));
export const BACKEND_ENTRY = fileURLToPath(new URL("./backend/shell.js", import.meta.url));

export const REFUSE_DEBUGGING: boolean = true;

/**
 * The scope policy of this build (I04-R14, S21): a build-time value, changed in this file and built
 * again, never by the environment. The public repository's is `default`; a fork that implements its
 * own policy sets its name here.
 */
export const SCOPE_POLICY = "default";

/** The name passed to the backend: the build's own, whatever the environment says. */
export function scopePolicyName(): string {
  return SCOPE_POLICY;
}

export function switches(): Switches {
  return {};
}
