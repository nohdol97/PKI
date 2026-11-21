// The preload's functions reach the main process only through these handlers, and
// every call is checked here (V01-R4, ADR 0008): the sender must be the app's own
// page and the arguments must match the function's schema exactly.
import { describe, expect, it, vi } from "vitest";
import { APP_ORIGIN } from "./app-protocol.ts";
import { BRIDGE, createBridgeHandlers } from "./bridge.ts";

const SESSION = { baseUrl: "", token: "t".repeat(43) };
const PAGE = `${APP_ORIGIN}/`;

function handlers(confirm = true) {
  const opened: string[] = [];
  const confirmExternal = vi.fn(async () => confirm);
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
    expect(yes.confirmExternal).toHaveBeenCalledWith("https://example.com/a?b=1");
    expect(yes.opened).toEqual(["https://example.com/a?b=1"]);

    const no = handlers(false);
    expect(await no.bridge.openExternal(PAGE, ["https://example.com/"])).toEqual({
      opened: false,
    });
    expect(no.opened).toEqual([]);
  });

  it("reports the secret store as not implemented and keeps nothing (T11)", async () => {
    const { bridge } = handlers();
    const unavailable = { ok: false, error: "not-implemented" };
    expect(await bridge.setSecret(PAGE, ["openai-key", "sk-canary"])).toEqual(unavailable);
    expect(await bridge.hasSecret(PAGE, ["openai-key"])).toEqual(unavailable);
    expect(await bridge.deleteSecret(PAGE, ["openai-key"])).toEqual(unavailable);
  });
});
