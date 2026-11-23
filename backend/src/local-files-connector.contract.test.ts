// I02B-C1: the `local-files` connector passes the Connector contract (SDK v2) with no violation, with
// files in the folder and with no location at all (I02B-R2: the instance is ready and has no change).
import type { Connector } from "@pki/contracts";
import { connectorContract } from "@pki/testkit";
import { renameSync } from "node:fs";
import { afterAll } from "vitest";
import { createLocalFilesConnector } from "./adapters/local-files-connector.ts";
import { world } from "./local-files-connector.test-support.ts";

const files = world();
files.write("a.md", "# A\n\nfirst\n");
files.write("b.md", "# B\n\nsecond\n");
files.write("c.md", "# C\n\nthird\n");
const empty = world();
// a world has one location; the second scenario has none
empty.db.run("DELETE FROM local_locations");
afterAll(() => {
  files.close();
  empty.close();
});

/** A connector whose `initialize` moves the origin on when told to, and lets files settle first (I02B-R15). */
const over = (w: typeof files, later?: () => void) => (): Connector => {
  const inner = createLocalFilesConnector(() => w.ports);
  return {
    ...inner,
    async initialize(config) {
      await inner.initialize(config);
      if ((config as { stage?: string } | null)?.stage === "later") later?.();
      for (let i = 0; i < 2; i++) {
        w.clock.t += 1_500;
        await inner.getChanges(null, { limit: 1_000, signal: new AbortController().signal });
      }
    },
  };
};

connectorContract(
  "local-files",
  over(files, () => {
    files.write("a.md", "# A\n\nfirst, edited\n");
    renameSync(`${files.root}/c.md`, `${files.outside}/c.md`);
  }),
  { config: { stage: "initial" }, later: { stage: "later" } },
);

connectorContract("local-files without a location", over(empty), { config: {} });
