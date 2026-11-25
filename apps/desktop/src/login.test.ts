// I06S-C3 (I06S-R3 to R5): the shell's login judgement over a fake `LoginHost`. The window is a scripted
// double: the test fires navigations, closings and cookies. Every value here is made up.
import { LOGIN_TIMEOUT_MS, type LoginSettings } from "@pki/contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createLoginRunner,
  loginWebPreferences,
  runLogin,
  type LoginDeps,
  type LoginHost,
} from "./login.ts";

const NAME = `connector.${"0123456789abcdef".repeat(2)}.session`;
const SETTINGS: LoginSettings = {
  name: NAME,
  startUrl: "https://idp.example.test/login",
  doneUrlPrefix: "https://app.example.test/home",
  cookies: ["sid", "csrf"],
};
const SID = "synthetic-sid-value-0001";
const CSRF = "synthetic-csrf-value-0002";

/** A fake host: the windows it opened, and what each does when the test says so. */
function fakeHost(
  held: { name: string; value: string }[] = [
    { name: "csrf", value: CSRF },
    { name: "other", value: "synthetic-unwanted" },
    { name: "sid", value: SID },
  ],
) {
  const opened: { url: string; partition: string }[] = [];
  const windows: {
    navigate(url: string): void;
    close(): void;
    disposed: number;
    askedUrls: string[];
  }[] = [];
  const host: LoginHost = {
    open(spec) {
      opened.push(spec);
      let navigate: (url: string) => void = () => undefined;
      let closed: () => void = () => undefined;
      const window = {
        navigate: (url: string) => navigate(url),
        close: () => closed(),
        disposed: 0,
        askedUrls: [] as string[],
      };
      windows.push(window);
      return {
        onNavigate: (listener) => void (navigate = listener),
        onClosed: (listener) => void (closed = listener),
        cookies: async (url) => (window.askedUrls.push(url), held),
        dispose: async () => void (window.disposed += 1),
      };
    },
  };
  return { host, opened, windows };
}

/** A store double that keeps what it was given; `ok: false` is an OS protection that cannot be used. */
function fakeStore(ok = true) {
  const stored: [string, string][] = [];
  return {
    stored,
    set: async (name: string, value: string) => (
      ok && stored.push([name, value]),
      ok ? ({ ok: true } as const) : ({ ok: false, error: "unavailable" } as const)
    ),
  };
}

/** A timer the test fires itself. */
function manualTimer() {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    startTimer: (run: () => void, ms: number) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(options: { ok?: boolean; held?: { name: string; value: string }[] } = {}) {
  const host = fakeHost(options.held);
  const store = fakeStore(options.ok);
  const timer = manualTimer();
  let n = 0;
  const deps: LoginDeps = {
    host: host.host,
    store,
    startTimer: timer.startTimer,
    newPartition: () => `pki-login-test-${++n}`,
  };
  return { ...host, store, timer, deps };
}

describe("login: the window (I06S-C3, R4)", () => {
  it("opens the start page in a fresh in-memory partition per login, never the app's own session", async () => {
    const a = setup();
    const first = runLogin(SETTINGS, a.deps);
    a.windows[0]?.close();
    await first;
    const second = runLogin(SETTINGS, a.deps);
    a.windows[1]?.close();
    await second;
    expect(a.opened.map((o) => o.url)).toEqual([SETTINGS.startUrl, SETTINGS.startUrl]);
    const partitions = a.opened.map((o) => o.partition);
    expect(new Set(partitions).size).toBe(2);
    for (const partition of partitions) {
      expect(partition).not.toBe("");
      expect(partition.startsWith("persist:")).toBe(false);
    }
  });

  it("the default partition name is random per login and in memory", async () => {
    const host = fakeHost();
    const deps: LoginDeps = {
      host: host.host,
      store: fakeStore(),
      startTimer: manualTimer().startTimer,
    };
    const one = runLogin(SETTINGS, deps);
    host.windows[0]?.close();
    await one;
    const two = runLogin(SETTINGS, deps);
    host.windows[1]?.close();
    await two;
    const [a, b] = host.opened.map((o) => o.partition);
    expect(a).not.toBe(b);
    expect(a?.startsWith("persist:") || b?.startsWith("persist:")).toBe(false);
  });

  it("the web preferences have no preload, are sandboxed and context-isolated, and carry the login's own partition", () => {
    const preferences = loginWebPreferences("pki-login-test-1");
    expect(preferences).not.toHaveProperty("preload");
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "pki-login-test-1",
    });
  });

  it("the Electron host builds its window from those preferences and names no preload of its own", () => {
    const source = readFileSync(new URL("./login-electron.ts", import.meta.url), "utf8");
    expect(source).toContain("webPreferences: loginWebPreferences(partition)");
    expect(source).not.toMatch(/preload/i);
    expect(source).not.toContain("defaultSession");
  });
});

describe("login: ending (I06S-C3, R5)", () => {
  it("reaching the done address with every cookie stores one line of JSON under the given name, clears the partition, and answers {ok:true} without a value", async () => {
    const t = setup();
    const done = runLogin(SETTINGS, t.deps);
    t.windows[0]?.navigate("https://idp.example.test/step-2"); // not the done address
    await settle();
    expect(t.store.stored).toEqual([]);
    t.windows[0]?.navigate("https://app.example.test/home?welcome=1");
    const result = await done;
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(SID);
    // declared order, only the declared cookies, one line
    const line = JSON.stringify({ cookies: { sid: SID, csrf: CSRF } });
    expect(t.store.stored).toEqual([[NAME, line]]);
    expect(line).not.toContain("\n");
    expect(t.windows[0]?.askedUrls).toEqual(["https://app.example.test/home?welcome=1"]);
    expect(t.windows[0]?.disposed).toBe(1);
    expect(t.timer.timers[0]?.cancelled).toBe(true);
    expect(t.timer.timers[0]?.ms).toBe(LOGIN_TIMEOUT_MS);
  });

  it("closing the window is cancelled, the timer firing is timeout, a missing cookie is no-session: nothing is stored and the window is cleaned up", async () => {
    const closed = setup();
    const a = runLogin(SETTINGS, closed.deps);
    closed.windows[0]?.close();
    expect(await a).toEqual({ ok: false, error: "cancelled" });

    const late = setup();
    const b = runLogin(SETTINGS, late.deps);
    late.timer.timers[0]?.run();
    expect(await b).toEqual({ ok: false, error: "timeout" });

    const partial = setup({ held: [{ name: "sid", value: SID }] });
    const c = runLogin(SETTINGS, partial.deps);
    partial.windows[0]?.navigate("https://app.example.test/home");
    expect(await c).toEqual({ ok: false, error: "no-session" });

    for (const t of [closed, late, partial]) {
      expect(t.store.stored).toEqual([]);
      expect(t.windows[0]?.disposed).toBe(1);
    }
  });

  it("answers too-large for a session over 8192 characters and store-unavailable when the store cannot write; neither stores", async () => {
    const big = setup({
      held: [
        { name: "sid", value: "x".repeat(9000) },
        { name: "csrf", value: CSRF },
      ],
    });
    const a = runLogin(SETTINGS, big.deps);
    big.windows[0]?.navigate("https://app.example.test/home");
    expect(await a).toEqual({ ok: false, error: "too-large" });
    expect(big.store.stored).toEqual([]);

    const down = setup({ ok: false });
    const b = runLogin(SETTINGS, down.deps);
    down.windows[0]?.navigate("https://app.example.test/home");
    expect(await b).toEqual({ ok: false, error: "store-unavailable" });
    expect(down.windows[0]?.disposed).toBe(1);
  });

  it("refuses a description that fails the rules again here (not a credential name, a plain-http address): invalid, no window", async () => {
    const t = setup();
    for (const bad of [
      { ...SETTINGS, name: "openai-compatible.api-key.0123456789abcdef0123456789abcdef" },
      { ...SETTINGS, startUrl: "http://example.com/login" },
      { ...SETTINGS, cookies: [] },
      undefined,
    ]) {
      expect(await runLogin(bad, t.deps)).toEqual({ ok: false, error: "invalid" });
    }
    expect(t.opened).toEqual([]);
  });

  it("prints nothing: no value reaches the console or the standard streams", async () => {
    const lines: string[] = [];
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(process.stdout, "write"),
      vi.spyOn(process.stderr, "write"),
    ].map((spy) =>
      spy.mockImplementation(
        ((...args: unknown[]) => (lines.push(args.map(String).join(" ")), true)) as never,
      ),
    );
    try {
      const t = setup();
      const done = runLogin(SETTINGS, t.deps);
      t.windows[0]?.navigate("https://app.example.test/home");
      await done;
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(lines.join("\n")).not.toContain(SID);
    expect(lines.join("\n")).not.toContain(CSRF);
  });
});

describe("login: one at a time (I06S-R5)", () => {
  it("a second login while a window is open is busy, and a new one opens once the first ended", async () => {
    const t = setup();
    const run = createLoginRunner(t.deps);
    const first = run(SETTINGS);
    expect(await run(SETTINGS)).toEqual({ ok: false, error: "busy" });
    expect(t.opened).toHaveLength(1);
    t.windows[0]?.close();
    expect(await first).toEqual({ ok: false, error: "cancelled" });
    const again = run(SETTINGS);
    expect(t.opened).toHaveLength(2);
    t.windows[1]?.close();
    await again;
  });
});
