// The preload's functions reach the main process only through these handlers, and
// every call is checked here (V01-R4, ADR 0008): the sender must be the app's own
// page and the arguments must match the function's schema exactly.
import { describe, expect, it, vi } from "vitest";
import { APP_ORIGIN } from "./app-protocol.ts";
import { BRIDGE, createBridgeHandlers, type ExternalTarget } from "./bridge.ts";

const SESSION = { baseUrl: "", token: "t".repeat(43) };
const PAGE = `${APP_ORIGIN}/`;

function handlers(confirm = true, picked: string | null = "/picked/folder") {
  const opened: string[] = [];
  const confirmExternal = vi.fn<(target: ExternalTarget) => Promise<boolean>>(async () => confirm);
  const stored = new Map<string, string>();
  const secrets = {
    set: vi.fn(
      async (name: string, value: string) => (stored.set(name, value), { ok: true as const }),
    ),
    has: vi.fn(async (name: string) => ({ ok: true as const, present: stored.has(name) })),
    delete: vi.fn(async (name: string) => (stored.delete(name), { ok: true as const })),
  };
  const registered: { ticket: string; kind: "folder"; path: string }[] = [];
  const bridge = createBridgeHandlers({
    session: SESSION,
    secrets,
    confirmExternal,
    openExternal: async (url) => void opened.push(url),
    pickLocation: async () => picked ?? undefined,
    registerLocationTicket: (input) => (registered.push(input), true),
  });
  return { bridge, opened, confirmExternal, secrets, stored, registered };
}

describe("bridge handlers", () => {
  it("names exactly the spec's preload functions", () => {
    expect(Object.keys(BRIDGE).sort()).toEqual(
      ["deleteSecret", "getSession", "hasSecret", "openExternal", "pickLocation", "setSecret"].sort(),
    );
    expect(Object.keys(handlers().bridge).sort()).toEqual(Object.keys(BRIDGE).sort());
  });

  it("pickLocation registers the picked path under a fresh ticket and returns only the ticket; a cancel registers nothing; a foreign sender is refused (S3)", async () => {
    const { bridge, registered } = handlers();
    const answer = (await bridge.pickLocation(PAGE, ["folder"])) as { ticket: string };
    expect(registered).toEqual([{ ticket: answer.ticket, kind: "folder", path: "/picked/folder" }]);
    expect(answer.ticket.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(answer)).not.toContain("/picked/folder");

    const second = (await bridge.pickLocation(PAGE, ["folder"])) as { ticket: string };
    expect(second.ticket).not.toBe(answer.ticket);

    const cancelled = handlers(true, null);
    expect(await cancelled.bridge.pickLocation(PAGE, ["folder"])).toEqual({ ticket: null });
    expect(cancelled.registered).toEqual([]);

    const foreign = handlers();
    await expect(foreign.bridge.pickLocation("https://evil.example/", ["folder"])).rejects.toThrow(
      "forbidden-sender",
    );
    await expect(foreign.bridge.pickLocation(PAGE, ["/etc"])).rejects.toThrow("invalid-input");
    expect(foreign.registered).toEqual([]);
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
    ["setSecret", ["openai-key", "x".repeat(8193)]],
  ] as const)("rejects %s(%j) before doing anything", async (name, args) => {
    const { bridge, opened, confirmExternal, secrets } = handlers();
    await expect(bridge[name](PAGE, [...args])).rejects.toThrow("invalid-input");
    expect(confirmExternal).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
    for (const fn of Object.values(secrets)) expect(fn).not.toHaveBeenCalled();
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

  it("stores, checks and deletes a secret, and answers without its value (T11)", async () => {
    const { bridge, stored } = handlers();
    expect(await bridge.setSecret(PAGE, ["openai-key", "sk-canary"])).toEqual({ ok: true });
    expect(stored.get("openai-key")).toBe("sk-canary");
    const present = await bridge.hasSecret(PAGE, ["openai-key"]);
    expect(present).toEqual({ ok: true, present: true });
    expect(JSON.stringify(present)).not.toContain("sk-canary");
    expect(await bridge.deleteSecret(PAGE, ["openai-key"])).toEqual({ ok: true });
    expect(await bridge.hasSecret(PAGE, ["openai-key"])).toEqual({ ok: true, present: false });
  });

  it("stores, checks and deletes a Connector credential name, answering without its value (I06-C15 ②③)", async () => {
    const { bridge, stored } = handlers();
    const name = `connector.${"0123456789abcdef".repeat(2)}.token`;
    const answers = [
      await bridge.setSecret(PAGE, [name, "sk-canary-bridge"]),
      await bridge.hasSecret(PAGE, [name]),
      await bridge.deleteSecret(PAGE, [name]),
    ];
    expect(answers).toEqual([{ ok: true }, { ok: true, present: true }, { ok: true }]);
    expect(JSON.stringify(answers)).not.toContain("sk-canary-bridge");
    expect(stored.has(name)).toBe(false);
    // no function that reads a value back: the page's whole secret surface is these three
    expect(
      Object.keys(bridge)
        .filter((k) => /secret/i.test(k))
        .sort(),
    ).toEqual(["deleteSecret", "hasSecret", "setSecret"]);
  });

  it("refuses a malformed credential name before the store sees it", async () => {
    const { bridge, secrets } = handlers();
    for (const name of ["Connector.X", `connector.${"0".repeat(32)}.${"a".repeat(40)}`, "a/b"]) {
      await expect(bridge.setSecret(PAGE, [name, "v"])).rejects.toThrow();
    }
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it("refuses secret calls from any other sender", async () => {
    const { bridge, secrets } = handlers();
    await expect(bridge.setSecret("https://evil.example/", ["openai-key", "v"])).rejects.toThrow(
      "forbidden-sender",
    );
    expect(secrets.set).not.toHaveBeenCalled();
  });
});
