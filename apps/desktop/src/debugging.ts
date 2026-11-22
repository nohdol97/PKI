// Debugging doors the production shell refuses to start with (V01-T15, review
// A-F1). Chromium's remote debugging hands the page, and with it the session token,
// to whoever connects; Node's inspector hands over the main process; V8 flags
// change how code runs. `devTools: false` closes none of them. Only the production
// build refuses (layout.production.ts): the source shell is driven by Playwright,
// which needs both. What starts before this code runs — `--inspect-brk`, a
// NODE_OPTIONS preload — needs the Electron fuses R04 sets ("T15가 넘기는 것" 9).

/** Chromium and Node switches, without the leading dashes. */
export const DEBUGGING_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "js-flags",
] as const;

const NODE_DEBUG_ARGUMENT = /(^|\s)--(inspect|debug)(-brk|-port|-wait)?(=|\s|$)/;

export interface DebuggingInput {
  hasSwitch(name: string): boolean;
  /** The main process's Node arguments. */
  execArgv: readonly string[];
  nodeOptions: string | undefined;
  /** Node's inspector is listening (node:inspector url()). */
  inspectorActive: boolean;
}

export function debuggingRequested(input: DebuggingInput): boolean {
  return (
    input.inspectorActive ||
    DEBUGGING_SWITCHES.some((name) => input.hasSwitch(name)) ||
    input.execArgv.some((arg) => NODE_DEBUG_ARGUMENT.test(arg)) ||
    NODE_DEBUG_ARGUMENT.test(input.nodeOptions ?? "")
  );
}
