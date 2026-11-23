// The normalizer host's entry file (I02B-R22): the process the backend, or Electron's main process on its
// request, starts. It runs the product's worker next to this file and takes no argument: nothing names
// another worker file here (a test host with that seam is testing/test-host.ts, which no product bundle
// may reach).
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { runHost } from "./host-core.ts";

// the source runs as .ts; the bundle writes .js next to this file
await runHost(
  new URL(`./isolated-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);
