// Where the backend reads a secret just before a call (V01-R4, R13, ADR 0010): from
// the Electron shell over the parent channel, or, in the browser development entry
// only, from an environment variable. Neither keeps the value.
import { openaiKeySecretName } from "@pki/providers";
import { describe, expect, it, vi } from "vitest";
import {
  channelSecrets,
  DEV_KEY_HOST_VARIABLE,
  DEV_KEY_VARIABLE,
  envSecrets,
  NO_SECRET_STORE,
} from "./secret-sources.ts";

const OPENAI_API_KEY_SECRET = openaiKeySecretName("api.synthetic.example");

describe("channelSecrets", () => {
  function setup(timeoutMs = 1000) {
    const posted: unknown[] = [];
    const secrets = channelSecrets((m) => void posted.push(m), timeoutMs);
    return { posted, secrets };
  }

  it("asks the shell by name and resolves with its answer", async () => {
    const { posted, secrets } = setup();
    const read = secrets.source.read(OPENAI_API_KEY_SECRET);
    expect(posted).toEqual([
      { type: "secret-request", id: 1, name: OPENAI_API_KEY_SECRET, mode: "read" },
    ]);
    expect(secrets.deliver({ type: "secret", id: 1, state: "present", value: "sk-x" })).toBe(true);
    await expect(read).resolves.toEqual({ state: "present", value: "sk-x" });
  });

  it("matches answers to requests by ID", async () => {
    const { secrets } = setup();
    const first = secrets.source.read("a");
    const second = secrets.source.read("b");
    secrets.deliver({ type: "secret", id: 2, state: "missing" });
    secrets.deliver({ type: "secret", id: 1, state: "unavailable" });
    await expect(first).resolves.toEqual({ state: "unavailable" });
    await expect(second).resolves.toEqual({ state: "missing" });
  });

  it.each([
    ["an unknown ID", { type: "secret", id: 99, state: "missing" }],
    ["an extra field", { type: "secret", id: 1, state: "missing", extra: 1 }],
    ["an empty value", { type: "secret", id: 1, state: "present", value: "" }],
    ["another message", { type: "stop" }],
    ["not an object", "secret"],
  ])("does not take %s as an answer", async (_name, message) => {
    const { secrets } = setup();
    void secrets.source.read("a");
    expect(secrets.deliver(message)).toBe(false);
  });

  it("asks for presence only, and refuses a presence answer that carries a value", async () => {
    const { posted, secrets } = setup();
    const has = secrets.source.has(OPENAI_API_KEY_SECRET);
    expect(posted).toEqual([
      { type: "secret-request", id: 1, name: OPENAI_API_KEY_SECRET, mode: "presence" },
    ]);
    expect(secrets.deliver({ type: "secret", id: 1, state: "present", value: "sk-x" })).toBe(false);
    expect(secrets.deliver({ type: "secret", id: 1, state: "present" })).toBe(true);
    await expect(has).resolves.toBe("present");
  });

  it("refuses a read answer without its value", async () => {
    const { secrets } = setup();
    void secrets.source.read("a");
    expect(secrets.deliver({ type: "secret", id: 1, state: "present" })).toBe(false);
  });

  it("answers unavailable when the shell does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      const { secrets } = setup(50);
      const read = secrets.source.read("a");
      vi.advanceTimersByTime(60);
      await expect(read).resolves.toEqual({ state: "unavailable" });
      // a late answer is dropped
      expect(secrets.deliver({ type: "secret", id: 1, state: "present", value: "late" })).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not ask for an invalid name", async () => {
    const { posted, secrets } = setup();
    await expect(secrets.source.read("Bad Name!")).resolves.toEqual({ state: "unavailable" });
    expect(posted).toEqual([]);
  });
});

describe("envSecrets (browser development entry only)", () => {
  it("gives the key only under the name of the host it is set for, read at call time", async () => {
    const env: Record<string, string | undefined> = {};
    const source = envSecrets(env);
    const name = openaiKeySecretName("api.synthetic.example");
    await expect(source.read(name)).resolves.toEqual({ state: "missing" });
    env[DEV_KEY_VARIABLE] = "sk-dev";
    await expect(source.read(name)).resolves.toEqual({ state: "missing" }); // no host given
    env[DEV_KEY_HOST_VARIABLE] = "API.Synthetic.Example";
    await expect(source.read(name)).resolves.toEqual({ state: "present", value: "sk-dev" });
    await expect(source.has(name)).resolves.toBe("present");
    await expect(source.read(openaiKeySecretName("evil.example"))).resolves.toEqual({
      state: "missing",
    });
    env[DEV_KEY_VARIABLE] = "";
    await expect(source.read(name)).resolves.toEqual({ state: "missing" });
    env[DEV_KEY_VARIABLE] = "x".repeat(8193);
    await expect(source.read(name)).resolves.toEqual({ state: "unavailable" });
  });
});

describe("NO_SECRET_STORE", () => {
  it("is unavailable, never empty-but-usable", async () => {
    await expect(NO_SECRET_STORE.read(OPENAI_API_KEY_SECRET)).resolves.toEqual({
      state: "unavailable",
    });
    await expect(NO_SECRET_STORE.has(OPENAI_API_KEY_SECRET)).resolves.toBe("unavailable");
  });
});
