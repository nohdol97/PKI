// Fake LLM Provider (V01-R8, ARCHITECTURE 5.1): the test double for the Provider
// boundary. It lives in testkit, which only test files may import
// (module-boundary devOnlyDependency), so no product build can bind it.
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderCapabilities,
  StructuredRequest,
  StructuredResponse,
} from "@pki/contracts";

/**
 * One scripted call: an answer, a thrown error, "hang" (pending until aborted or
 * cancelled) or "ignore-abort" (pending forever, a Provider that ignores its signal).
 */
export type FakeStep = { output: unknown } | { error: Error } | "hang" | "ignore-abort";

export interface FakeProviderOptions {
  id?: LLMProvider["id"];
  transport?: LLMProvider["transport"];
  /** Consumed one step per call; when empty, calls answer with `answer`. */
  script?: FakeStep[];
  /** The output of an unscripted call; default `{ reply: "ok" }`. */
  answer?: (request: StructuredRequest) => unknown;
  /** How long an answering call stays in flight. */
  delayMs?: number;
  capabilities?: Partial<ProviderCapabilities>;
  /** How cancel behaves: stop the call (default), never settle, or throw synchronously. */
  cancelMode?: "stop" | "never-settles" | "throws";
}

export class FakeProvider implements LLMProvider {
  readonly id: LLMProvider["id"];
  readonly transport: LLMProvider["transport"];
  /** Every request received, as received. */
  readonly requests: StructuredRequest[] = [];
  /** Every cancel call, known request or not. */
  readonly cancelled: string[] = [];
  /** The signal of every call, in order. */
  readonly signals: AbortSignal[] = [];
  inFlight = 0;
  maxInFlight = 0;
  readonly #script: FakeStep[];
  readonly #delayMs: number;
  readonly #answer: (request: StructuredRequest) => unknown;
  readonly #cancelMode: NonNullable<FakeProviderOptions["cancelMode"]>;
  readonly #capabilities: ProviderCapabilities;
  readonly #running = new Map<string, (reason: Error) => void>();

  constructor(options: FakeProviderOptions = {}) {
    this.id = options.id ?? "openai-compatible";
    this.transport = options.transport ?? "http";
    this.#script = [...(options.script ?? [])];
    this.#delayMs = options.delayMs ?? 0;
    this.#answer = options.answer ?? (() => ({ reply: "ok" }));
    this.#cancelMode = options.cancelMode ?? "stop";
    this.#capabilities = {
      structuredOutput: true,
      cancel: true,
      egress: "external",
      ...options.capabilities,
    };
  }

  async detect() {
    return { installed: true, version: "fake-1" };
  }
  async checkAuthentication() {
    return "unknown" as const;
  }
  async checkHealth() {
    return { state: "ok" as const };
  }
  getCapabilities() {
    return this.#capabilities;
  }

  async generate(request: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
    const output = await this.#run({ ...request, outputSchema: {} }, signal);
    return { text: JSON.stringify(output) };
  }

  async generateStructured(
    request: StructuredRequest,
    signal: AbortSignal,
  ): Promise<StructuredResponse> {
    return { output: await this.#run(request, signal) };
  }

  cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
    if (this.#cancelMode === "throws") throw new Error("cancel failed");
    if (this.#cancelMode === "never-settles") return new Promise(() => undefined);
    this.#running.get(requestId)?.(new Error("cancelled"));
    return Promise.resolve();
  }

  #run(request: StructuredRequest, signal: AbortSignal): Promise<unknown> {
    this.requests.push(structuredClone(request));
    this.signals.push(signal);
    const step = this.#script.shift() ?? { output: this.#answer(request) };
    if (step === "ignore-abort") return new Promise(() => undefined);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise<unknown>((resolve, reject) => {
      const stop = (reason: Error) => reject(reason);
      if (signal.aborted) return stop(new Error("aborted"));
      signal.addEventListener("abort", () => stop(new Error("aborted")), { once: true });
      this.#running.set(request.requestId, stop);
      if (step === "hang") return;
      setTimeout(
        () => ("error" in step ? reject(step.error) : resolve(step.output)),
        this.#delayMs,
      );
    }).finally(() => {
      this.inFlight--;
      this.#running.delete(request.requestId);
    });
  }
}
