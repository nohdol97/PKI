// The sandboxed preload cannot import the channel table (only "electron" is
// requirable there), so this pins its copy to bridge.ts: same function names, each
// invoking its own channel with the page's arguments passed through unchanged for
// the main process to check.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { BRIDGE } from "./bridge.ts";

it("exposes exactly the bridge functions, each on its own channel", async () => {
  const exposed: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  const invoked: unknown[][] = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, api: (typeof exposed)[string]) => (exposed[key] = api),
    },
    ipcRenderer: { invoke: async (...args: unknown[]) => void invoked.push(args) },
  };
  const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  runInNewContext(source, {
    require: (name: string) => {
      if (name !== "electron") throw new Error(`preload required ${name}`);
      return electron;
    },
  });

  expect(Object.keys(exposed)).toEqual(["pki"]);
  const api = exposed.pki ?? {};
  expect(Object.keys(api).sort()).toEqual(Object.keys(BRIDGE).sort());
  for (const [name, channel] of Object.entries(BRIDGE)) {
    invoked.length = 0;
    await api[name]?.("a", 2);
    expect(invoked).toEqual([[channel, "a", 2]]);
  }
});
