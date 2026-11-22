// The shell entry's command line in a source run (development and tests, V01-T15):
// the screens' origins, and the canonical DB folder and the test Connector's
// synthetic JSONL that the shell passes from its --pki-data-dir / --pki-fixtures.
// The production build bundles shell-options.production.ts in place of this
// module (apps/desktop/build/bundle.ts), so the artifact takes neither switch.
import { parseArgs } from "node:util";
import { fixtureConnectors, type ConnectorSet } from "./composition.ts";

export interface ShellOptions {
  origins: string[];
  dataDir?: string;
  /** The scope policy by name (I04-R14); the desktop shell passes it, none: the default. */
  scopePolicy?: string;
  connectors?: ConnectorSet;
}

/** `args` default: the process arguments, as parseArgs reads them. */
export function shellOptions(args?: string[]): ShellOptions {
  const { values } = parseArgs({
    args,
    options: {
      origin: { type: "string", multiple: true, default: [] },
      "data-dir": { type: "string" },
      fixtures: { type: "string" },
      "scope-policy": { type: "string" },
    },
  });
  return {
    origins: values.origin,
    ...(values["data-dir"] === undefined ? {} : { dataDir: values["data-dir"] }),
    ...(values["scope-policy"] === undefined ? {} : { scopePolicy: values["scope-policy"] }),
    ...(values.fixtures === undefined ? {} : { connectors: fixtureConnectors(values.fixtures) }),
  };
}
