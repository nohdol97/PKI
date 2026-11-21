// V01-C4 `provider.contract` (V01-R8, ARCHITECTURE 5.1): the suite every
// LLMProvider implementation runs from its own test file — the fake Provider
// here, the CLI Providers against a fake CLI (T10), the OpenAI-compatible
// Provider against a fake HTTP server (T11).
import {
  ProviderError,
  type LLMProvider,
  type LLMRequest,
  type StructuredRequest,
} from "@pki/contracts";
import { beforeEach, describe, expect, it } from "vitest";

export function providerRequest(requestId = "req-1", destination = "test"): LLMRequest {
  return {
    requestId,
    taskKind: "connection-test",
    trigger: "user",
    dataClassification: "synthetic",
    egress: { allowed: true, destination, policyVersion: "test" },
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

export function structuredRequest(requestId = "req-1", destination = "test"): StructuredRequest {
  return {
    ...providerRequest(requestId, destination),
    outputSchema: {
      type: "object",
      properties: { reply: { type: "string" } },
      required: ["reply"],
    },
  };
}

const live = () => new AbortController().signal;

export interface ProviderContractOptions<P extends LLMProvider> {
  /** How many model calls `provider` has made (a fake CLI's or fake server's count). */
  modelCalls: (provider: P) => number;
  /** A Provider whose backend fails every generation (a fake CLI exiting non-zero, a 500). */
  failing: () => P;
  /**
   * The egress destination the requests carry (default "test"): an HTTP Provider
   * sends only to the destination the Broker's decision named (T08 item 4).
   */
  destination?: () => string;
  /**
   * What the Broker adds to every request for this Provider before it runs; for a
   * CLI, the execution profile (a CLI runs nothing without one). Default: none.
   */
  prepare?: <R extends LLMRequest>(request: R) => R;
}

export function providerContract<P extends LLMProvider>(
  name: string,
  create: () => P,
  options: ProviderContractOptions<P>,
): void {
  describe(`provider.contract: ${name}`, () => {
    let provider: P;
    const at = () => options.destination?.() ?? "test";
    const prepare = options.prepare ?? (<R>(request: R) => request);
    const plain = (id?: string) => prepare(providerRequest(id, at()));
    const structured = (id?: string) => prepare(structuredRequest(id, at()));

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
      const before = options.modelCalls(provider);
      const info = await provider.detect();
      expect(typeof info.installed).toBe("boolean");
      expect(["authenticated", "unauthenticated", "unknown"]).toContain(
        await provider.checkAuthentication(),
      );
      const health = await provider.checkHealth();
      expect(["ok", "unavailable"]).toContain(health.state);
      expect(options.modelCalls(provider)).toBe(before);
    });

    it("counts a generation as a model call", async () => {
      const before = options.modelCalls(provider);
      await provider.generate(plain(), live());
      expect(options.modelCalls(provider)).toBe(before + 1);
    });

    it("reports a failed generation as a ProviderError that says whether to retry", async () => {
      const legs: ((p: P) => Promise<unknown>)[] = [(p) => p.generate(plain(), live())];
      // a Provider without structured output is never asked for it (the Broker checks)
      if (options.failing().getCapabilities().structuredOutput) {
        legs.push((p: P) => p.generateStructured(structured(), live()));
      }
      for (const run of legs) {
        const error = await run(options.failing()).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(ProviderError);
        expect(typeof (error as ProviderError).retryable).toBe("boolean");
      }
    });

    it("generates text for a request", async () => {
      const response = await provider.generate(plain(), live());
      expect(typeof response.text).toBe("string");
    });

    it("returns structured output for a structured request when it supports it", async () => {
      if (!provider.getCapabilities().structuredOutput) return;
      const response = await provider.generateStructured(structured(), live());
      expect(response).toHaveProperty("output");
    });

    it("rejects a call whose signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(provider.generate(plain(), controller.signal)).rejects.toThrow();
      await expect(provider.generateStructured(structured(), controller.signal)).rejects.toThrow();
    });

    it("stops an in-flight call when its signal aborts", async () => {
      const controller = new AbortController();
      const call = provider.generate(plain("req-abort"), controller.signal);
      controller.abort();
      await expect(call).rejects.toThrow();
    });

    it("accepts cancel for an unknown request, and cancels a running one when it can", async () => {
      await expect(provider.cancel("no-such-request")).resolves.toBeUndefined();
      if (!provider.getCapabilities().cancel) return;
      const call = provider.generate(plain("req-cancel"), live());
      await provider.cancel("req-cancel");
      await expect(call).rejects.toThrow();
    });
  });
}
