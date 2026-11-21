// V01-C4 (V01-R11, ADR 0005 item 3): the local-model Provider keeps the contract's
// shape and answers every call "not implemented"; it never runs anything.
import { ProviderError, type LLMProvider } from "@pki/contracts";
import { providerRequest, structuredRequest } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import { LOCAL_MODEL_NOT_IMPLEMENTED, LocalModelProvider } from "./local-model.ts";

const live = () => new AbortController().signal;

describe("LocalModelProvider", () => {
  const provider: LLMProvider = new LocalModelProvider();

  it("is the local, unimplemented Provider", async () => {
    expect(provider.id).toBe("local-model");
    expect(provider.getCapabilities()).toEqual({
      structuredOutput: false,
      cancel: false,
      egress: "local",
    });
    expect(await provider.detect()).toEqual({ installed: false });
    expect(await provider.checkAuthentication()).toBe("unknown");
    expect(await provider.checkHealth()).toEqual({
      state: "unavailable",
      reason: LOCAL_MODEL_NOT_IMPLEMENTED,
    });
    await expect(provider.cancel("any")).resolves.toBeUndefined();
  });

  it("refuses every generation as not implemented, not retryable", async () => {
    for (const call of [
      provider.generate(providerRequest(), live()),
      provider.generateStructured(structuredRequest(), live()),
    ]) {
      const error = await call.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ message: LOCAL_MODEL_NOT_IMPLEMENTED, retryable: false });
    }
  });
});
