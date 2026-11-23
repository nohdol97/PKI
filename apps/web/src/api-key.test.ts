import { describe, expect, it, vi } from "vitest";
import {
  deleteApiKey,
  keyStatusText,
  MAX_SECRET_LENGTH,
  saveApiKey,
  secretBridge,
} from "./api-key.ts";

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

  // I06F-C1 ①②③: the check sits in the one function that calls the preload, so no screen can skip it
  it("I06F-C1 refuses a line break or a value over the limit before the shell is asked, and stores exactly the limit", async () => {
    const bridge = {
      setSecret: vi.fn(async () => ({ ok: true })),
      deleteSecret: vi.fn(async () => ({ ok: true })),
    };
    for (const value of ["a\nb", "a\rb", "a\r\nb"]) {
      expect(await saveApiKey(bridge, NAME, value)).toBe("line-break");
    }
    expect(await saveApiKey(bridge, NAME, "x".repeat(MAX_SECRET_LENGTH + 1))).toBe("too-long");
    expect(bridge.setSecret).not.toHaveBeenCalled();
    const whole = "x".repeat(8192);
    expect(MAX_SECRET_LENGTH).toBe(8192);
    expect(await saveApiKey(bridge, NAME, whole)).toBe("saved");
    expect(bridge.setSecret).toHaveBeenCalledWith(NAME, whole);
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
