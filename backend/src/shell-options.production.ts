// The shell entry's command line in the production build (V01-T15), bundled in
// place of shell-options.ts: the screens' origins only. The canonical DB is the
// per-user data directory and the Connectors are the product's; any other
// argument fails the start (parseArgs is strict), the closed side.
import { parseArgs } from "node:util";
import type { ShellOptions } from "./shell-options.ts";

/** `args` default: the process arguments, as parseArgs reads them. */
export function shellOptions(args?: string[]): ShellOptions {
  const { values } = parseArgs({
    args,
    options: { origin: { type: "string", multiple: true, default: [] } },
  });
  return { origins: values.origin };
}
