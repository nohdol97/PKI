// The shell entry's command line in the production build (V01-T15), bundled in
// place of shell-options.ts: the screens' origins only. The canonical DB is the
// per-user data directory and the Connectors are the product's plus the registration's; any other
// argument, `--scope-policy` included (the policy is the registration's, I05-R15), fails the start
// (parseArgs is strict), the closed side.
import { parseArgs } from "node:util";
import type { ShellOptions } from "./shell-options.ts";

/** `args` default: the process arguments, as parseArgs reads them. */
export function shellOptions(args?: string[]): ShellOptions {
  const { values } = parseArgs({
    args,
    options: {
      origin: { type: "string", multiple: true, default: [] },
      // the shell passes its user-data folder, which no location may be or lie in (I02B-R48)
      "user-data": { type: "string" },
    },
  });
  return {
    origins: values.origin,
    ...(values["user-data"] === undefined ? {} : { userData: values["user-data"] }),
  };
}
