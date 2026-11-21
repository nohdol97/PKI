// The preload's functions reach the main process only through these handlers, and
// every call is checked here (V01-R4, ADR 0008): the sender must be the app's own
// page and the arguments must match the function's schema exactly.
import { describe, expect, it, vi } from "vitest";
import { APP_ORIGIN } from "./app-protocol.ts";
import { BRIDGE, createBridgeHandlers, type ExternalTarget } from "./bridge.ts";

const SESSION = { baseUrl: "", token: "t".repeat(43) };
const PAGE = `${APP_ORIGIN}/`;

function handlers(confirm = true) {
  const opened: string[] = [];
  const confirmExternal = vi.fn<(target: ExternalTarget) => Promise<boolean>>(async () => confirm);
  const bridge = createBridgeHandlers({
    session: SESSION,
    confirmExternal,
    openExternal: async (url) => void opened.push(url),
  });
  return { bridge, opened, confirmExternal };
}

describe("bridge handlers", () => {
  it("names exactly the spec's preload functions", () => {
    expect(Object.keys(BRIDGE).sort()).toEqual(
      ["deleteSecret", "getSession", "hasSecret", "openExternal", "setSecret"].sort(),
    );
    expect(Object.keys(handlers().bridge).sort()).toEqual(Object.keys(BRIDGE).sort());
  });

  it("gives the app page its session", async () => {
    expect(await handlers().bridge.getSession(PAGE, [])).toEqual(SESSION);
  });

  it.each([
    ["another origin", "https://evil.example/"],
    ["a file page", "file:///tmp/x.html"],
    ["the backend's own origin", "http://127.0.0.1:4000/"],
    ["no sender frame", undefined],
  ])("refuses a call from %s", async (_name, sender) => {
    await expect(handlers().bridge.getSession(sender, [])).rejects.toThrow("forbidden-sender");
  });

  it.each([
    ["getSession", ["extra"]],
    ["setSecret", ["openai-key"]],
    ["setSecret", ["openai-key", ""]],
    ["setSecret", ["Bad Name!", "v"]],
    ["setSecret", ["openai-key", 42]],
    ["hasSecret", [{ name: "openai-key" }]],
    ["deleteSecret", []],
    ["openExternal", [42]],
    ["openExternal", ["https://a.example/", "extra"]],
  ] as const)("rejects %s(%j) before doing anything", async (name, args) => {
    const { bridge, opened, confirmExternal } = handlers();
    await expect(bridge[name](PAGE, [...args])).rejects.toThrow("invalid-input");
    expect(confirmExternal).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it.each([
    "http://example.com/",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "app://pki/",
    "https://user:pw@example.com/",
    "not a url",
    `https://a.example/${"a".repeat(2048)}`,
  ])("opens no external link that is not plain https: %s", async (url) => {
    const { bridge, opened, confirmExternal } = handlers();
    await expect(bridge.openExternal(PAGE, [url])).rejects.toThrow("invalid-input");
    expect(confirmExternal).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it("opens an https link only after the user confirms it", async () => {
    const yes = handlers(true);
    expect(await yes.bridge.openExternal(PAGE, ["https://example.com/a?b=1"])).toEqual({
      opened: true,
    });
    expect(yes.confirmExternal).toHaveBeenCalledWith({
      href: "https://example.com/a?b=1",
      hostname: "example.com",
    });
    expect(yes.opened).toEqual(["https://example.com/a?b=1"]);

    const no = handlers(false);
    expect(await no.bridge.openExternal(PAGE, ["https://example.com/"])).toEqual({
      opened: false,
    });
    expect(no.opened).toEqual([]);
  });

  // The user confirms the destination that will open, not the page's rendering of it:
  // the string is normalised once, the dialog gets that form with the punycode host,
  // and the same href goes to the OS.
  it.each([
    [
      "a Cyrillic look-alike host",
      "https://\u0430pple.com/",
      "xn--pple-43d.com",
      "https://xn--pple-43d.com/",
    ],
    [
      "a right-to-left override",
      "https://evil.example/\u202emoc.elppa",
      "evil.example",
      "https://evil.example/%E2%80%AEmoc.elppa",
    ],
  ])("confirms and opens the normalised URL for %s", async (_name, input, hostname, href) => {
    const { bridge, opened, confirmExternal } = handlers(true);
    expect(await bridge.openExternal(PAGE, [input])).toEqual({ opened: true });
    expect(confirmExternal).toHaveBeenCalledWith({ href, hostname });
    expect(opened).toEqual([href]);
    expect(JSON.stringify([confirmExternal.mock.calls, opened])).not.toMatch(/[\u0430\u202e]/);
  });

  it("reports the secret store as not implemented and keeps nothing (T11)", async () => {
    const { bridge } = handlers();
    const unavailable = { ok: false, error: "not-implemented" };
    expect(await bridge.setSecret(PAGE, ["openai-key", "sk-canary"])).toEqual(unavailable);
    expect(await bridge.hasSecret(PAGE, ["openai-key"])).toEqual(unavailable);
    expect(await bridge.deleteSecret(PAGE, ["openai-key"])).toEqual(unavailable);
  });
});
