// V01-T15 (review A-F1): the production shell refuses to start when asked to open a
// debugging door: Chromium's remote debugging gives the page (and its session token)
// to whoever connects, and Node's inspector the main process. devTools: false does
// not close either.
import { describe, expect, it } from "vitest";
import { debuggingRequested, DEBUGGING_SWITCHES } from "./debugging.ts";

const none = {
  hasSwitch: () => false,
  execArgv: [] as string[],
  nodeOptions: undefined as string | undefined,
  inspectorActive: false,
};

describe("debuggingRequested", () => {
  it("is false for a plain start", () => {
    expect(debuggingRequested(none)).toBe(false);
    expect(debuggingRequested({ ...none, nodeOptions: "--max-old-space-size=4096" })).toBe(false);
  });

  it.each([...DEBUGGING_SWITCHES])("is true with the switch --%s", (name) => {
    expect(debuggingRequested({ ...none, hasSwitch: (n) => n === name })).toBe(true);
  });

  it("covers remote debugging, the inspector and V8 flags", () => {
    expect([...DEBUGGING_SWITCHES].sort()).toEqual([
      "inspect",
      "inspect-brk",
      "inspect-port",
      "js-flags",
      "remote-debugging-pipe",
      "remote-debugging-port",
    ]);
  });

  it.each([["--inspect"], ["--inspect=0"], ["--inspect-brk=9229"], ["--debug-port=1"]])(
    "is true with the Node argument %s",
    (arg) => {
      expect(debuggingRequested({ ...none, execArgv: [arg] })).toBe(true);
      expect(debuggingRequested({ ...none, nodeOptions: `--foo ${arg}` })).toBe(true);
    },
  );

  it("is true while Node's inspector is open, however it was opened", () => {
    expect(debuggingRequested({ ...none, inspectorActive: true })).toBe(true);
  });
});
