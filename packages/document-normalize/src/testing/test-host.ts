// The test host's entry file (I02B-R25, test code): the product host with a test worker. `--worker <file>`
// names the worker file; the spawner of a test passes it. The product's `host.ts` has no such argument.
import { pathToFileURL } from "node:url";
import { runHost } from "../host-core.ts";

const at = process.argv.indexOf("--worker");
const file = at < 0 ? undefined : process.argv[at + 1];
if (file === undefined) throw new Error("test-host needs --worker <file>");
await runHost(pathToFileURL(file));
