import { describe, expect, it, vi } from "vitest";
import { deleteApiKey, keyStatusText, saveApiKey, secretBridge } from "./api-key.ts";

const NAME = `openai-compatible.api-key.${"a".repeat(32)}`;

describe("API key entry", () => {
  it("stores the key under the backend's host-bound name and reports the shell's answer", async () => {
    const bridge = {
      setSecret: vi.fn(async () => ({ ok: true })),
      deleteSecret: vi.fn(async () => ({ ok: true })),
    };
    expect(await saveApiKey(bridge, NAME, "sk-x")).toBe("saved");
    expect(bridge.setSecret).toHaveBeenCalledWith(NAME, "sk-x");
    bridge.setSecret.mockResolvedValueOnce({ ok: false, error: "unavailable" } as never);
    expect(await saveApiKey(bridge, NAME, "sk-x")).toBe("unavailable");
    expect(await deleteApiKey(bridge, NAME)).toBe(true);
    expect(bridge.deleteSecret).toHaveBeenCalledWith(NAME);
  });

  it("finds the bridge only where the preload gives one (Electron)", () => {
    expect(secretBridge(undefined)).toBeUndefined();
    expect(secretBridge({ getSession: () => undefined })).toBeUndefined();
    const pki = { setSecret: async () => ({}), deleteSecret: async () => ({}) };
    expect(secretBridge(pki)).toBe(pki);
  });

  it("says whose key it is and when it must be entered again", () => {
    const base = { baseUrl: "https://a.example/v1", model: "m", keyName: NAME };
    expect(keyStatusText({ ...base, host: "a.example", key: "present" })).toContain("a.example");
    expect(keyStatusText({ ...base, host: "b.example", key: "missing" })).toContain(
      "b.example에 쓸 키를 입력",
    );
    expect(keyStatusText({ ...base, host: "a.example", key: "unavailable" })).toContain(
      "사용할 수 없음",
    );
    expect(
      keyStatusText({ baseUrl: null, model: null, host: null, keyName: null, key: null }),
    ).toBe("주소를 먼저 저장하세요");
  });
});
