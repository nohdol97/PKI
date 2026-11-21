// Where the backend reads a secret just before a call (V01-R4, R13, ADR 0010): from
// the Electron shell over the parent channel, or, in the browser development entry
// only, from an environment variable. Neither keeps the value.
import { OPENAI_API_KEY_SECRET } from "@pki/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  channelSecrets,
  devSecretVariable,
  envSecrets,
  NO_SECRET_STORE,
} from "./secret-sources.ts";

describe("channelSecrets", () => {
  function setup(timeoutMs = 1000) {
    const posted: unknown[] = [];
    const secrets = channelSecrets((m) => void posted.push(m), timeoutMs);
    return { posted, secrets };
  }

  it("asks the shell by name and resolves with its answer", async () => {
    const { posted, secrets } = setup();
    const read = secrets.source.read(OPENAI_API_KEY_SECRET);
    expect(posted).toEqual([{ type: "secret-request", id: 1, name: OPENAI_API_KEY_SECRET }]);
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
  it("reads PKI_DEV_SECRET_<NAME> at call time", async () => {
    expect(devSecretVariable(OPENAI_API_KEY_SECRET)).toBe(
      "PKI_DEV_SECRET_OPENAI_COMPATIBLE_API_KEY",
    );
    const env: Record<string, string | undefined> = {};
    const source = envSecrets(env);
    await expect(source.read(OPENAI_API_KEY_SECRET)).resolves.toEqual({ state: "missing" });
    env.PKI_DEV_SECRET_OPENAI_COMPATIBLE_API_KEY = "sk-dev";
    await expect(source.read(OPENAI_API_KEY_SECRET)).resolves.toEqual({
      state: "present",
      value: "sk-dev",
    });
    env.PKI_DEV_SECRET_OPENAI_COMPATIBLE_API_KEY = "";
    await expect(source.read(OPENAI_API_KEY_SECRET)).resolves.toEqual({ state: "missing" });
    env.PKI_DEV_SECRET_OPENAI_COMPATIBLE_API_KEY = "x".repeat(8193);
    await expect(source.read(OPENAI_API_KEY_SECRET)).resolves.toEqual({ state: "unavailable" });
    await expect(source.read("Bad Name!")).resolves.toEqual({ state: "unavailable" });
  });
});

describe("NO_SECRET_STORE", () => {
  it("is unavailable, never empty-but-usable", async () => {
    await expect(NO_SECRET_STORE.read(OPENAI_API_KEY_SECRET)).resolves.toEqual({
      state: "unavailable",
    });
  });
});
