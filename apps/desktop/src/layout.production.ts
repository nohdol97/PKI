// The app folder's layout (V01-T15), bundled in place of layout.ts: next to
// main.js, the screens in web/ and the bundled backend in backend/shell.js. No
// switch: the canonical DB is the per-user data directory and there is no test
// Connector.
import { fileURLToPath } from "node:url";
import type { Switches } from "./layout.ts";

export const WEB_ROOT = fileURLToPath(new URL("./web/", import.meta.url));
export const BACKEND_ENTRY = fileURLToPath(new URL("./backend/shell.js", import.meta.url));

export function switches(): Switches {
  return {};
}
