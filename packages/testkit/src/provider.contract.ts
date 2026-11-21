// V01-C4 `provider.contract` (V01-R8, ARCHITECTURE 5.1): the suite every
// LLMProvider implementation runs from its own test file — the fake Provider
// here, the CLI Providers against a fake CLI (T10), the OpenAI-compatible
// Provider against a fake HTTP server (T11).
import type { LLMProvider, LLMRequest, StructuredRequest } from "@pki/contracts";
import { beforeEach, describe, expect, it } from "vitest";

export function providerRequest(requestId = "req-1"): LLMRequest {
  return {
    requestId,
    taskKind: "connection-test",
    trigger: "user",
    dataClassification: "synthetic",
    egress: { allowed: true, destination: "test", policyVersion: "test" },
    schemaVersion: 1,
    budget: { timeoutMs: 1000 },
    retryable: false,
    input: {
      instructions: "Reply with one word.",
      untrustedDocuments: [{ id: "doc-1", title: "title", body: "body" }],
      candidates: [],
    },
  };
}

export function structuredRequest(requestId = "req-1"): StructuredRequest {
  return {
    ...providerRequest(requestId),
    outputSchema: {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
    },
  };
}

const live = () => new AbortController().signal;

export function providerContract(name: string, create: () => LLMProvider): void {
  describe(`provider.contract: ${name}`, () => {
    let provider: LLMProvider;

    beforeEach(() => {
      provider = create();
    });

    it("names itself and its transport", () => {
      expect(["claude-code", "codex", "openai-compatible", "local-model"]).toContain(provider.id);
      expect(["cli", "http"]).toContain(provider.transport);
    });

    it("declares its capabilities", () => {
      const caps = provider.getCapabilities();
      expect(typeof caps.structuredOutput).toBe("boolean");
      expect(typeof caps.cancel).toBe("boolean");
      expect(["external", "local"]).toContain(caps.egress);
    });

    it("detects, checks authentication and health without a model call", async () => {
      const info = await provider.detect();
      expect(typeof info.installed).toBe("boolean");
      expect(["authenticated", "unauthenticated", "unknown"]).toContain(
        await provider.checkAuthentication(),
      );
      const health = await provider.checkHealth();
      expect(["ok", "unavailable"]).toContain(health.state);
    });

    it("generates text for a request", async () => {
      const response = await provider.generate(providerRequest(), live());
      expect(typeof response.text).toBe("string");
    });

    it("returns structured output for a structured request when it supports it", async () => {
      if (!provider.getCapabilities().structuredOutput) return;
      const response = await provider.generateStructured(structuredRequest(), live());
      expect(response).toHaveProperty("output");
    });

    it("rejects a call whose signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(provider.generate(providerRequest(), controller.signal)).rejects.toThrow();
      await expect(
        provider.generateStructured(structuredRequest(), controller.signal),
      ).rejects.toThrow();
    });

    it("stops an in-flight call when its signal aborts", async () => {
      const controller = new AbortController();
      const call = provider.generate(providerRequest("req-abort"), controller.signal);
      controller.abort();
      await expect(call).rejects.toThrow();
    });

    it("accepts cancel for an unknown request, and cancels a running one when it can", async () => {
      await expect(provider.cancel("no-such-request")).resolves.toBeUndefined();
      if (!provider.getCapabilities().cancel) return;
      const call = provider.generate(providerRequest("req-cancel"), live());
      await provider.cancel("req-cancel");
      await expect(call).rejects.toThrow();
    });
  });
}
