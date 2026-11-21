// Fake LLM Provider (V01-R8, ARCHITECTURE 5.1): the test double for the Provider
// boundary. It lives in testkit, which only test files may import
// (module-boundary devOnlyDependency), so no product build can bind it.
import {
  UnsupportedCapabilityError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ProviderCapabilities,
  type ProviderInfo,
  type StructuredRequest,
  type StructuredResponse,
} from "@pki/contracts";

/**
 * One scripted call: an answer, a thrown error, "hang" (pending until aborted or
 * cancelled) or "ignore-abort" (ignores its signal and ends only by cancel, as a
 * CLI process does until it is killed).
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
  /**
   * How cancel behaves: stop the call with that request ID at once (default),
   * stop it 15 ms later ("async", like killing a process), never settle, or
   * throw synchronously.
   */
  cancelMode?: "stop" | "async" | "never-settles" | "throws";
  /** What the fixed-argument version query reports; default installed, version "fake-1". */
  detect?: () => Promise<ProviderInfo>;
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
  readonly #detect: () => Promise<ProviderInfo>;

  constructor(options: FakeProviderOptions = {}) {
    this.id = options.id ?? "openai-compatible";
    this.transport = options.transport ?? "http";
    this.#script = [...(options.script ?? [])];
    this.#delayMs = options.delayMs ?? 0;
    this.#answer = options.answer ?? (() => ({ reply: "ok" }));
    this.#cancelMode = options.cancelMode ?? "stop";
    this.#detect = options.detect ?? (async () => ({ installed: true, version: "fake-1" }));
    this.#capabilities = {
      structuredOutput: true,
      cancel: true,
      egress: "external",
      ...options.capabilities,
    };
  }

  /** Counts as a version query, never a model call. */
  detect(): Promise<ProviderInfo> {
    return this.#detect();
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
  /** Calls still running, keyed by request ID. */
  get pending() {
    return this.#running.size;
  }

  async generate(request: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
    const output = await this.#run({ ...request, outputSchema: {} }, signal);
    return { text: JSON.stringify(output) };
  }

  async generateStructured(
    request: StructuredRequest,
    signal: AbortSignal,
  ): Promise<StructuredResponse> {
    if (!this.#capabilities.structuredOutput) {
      throw new UnsupportedCapabilityError("structuredOutput");
    }
    return { output: await this.#run(request, signal) };
  }

  cancel(requestId: string): Promise<void> {
    this.cancelled.push(requestId);
    if (this.#cancelMode === "throws") throw new Error("cancel failed");
    if (this.#cancelMode === "never-settles") return new Promise(() => undefined);
    const stop = () => this.#running.get(requestId)?.(new Error("cancelled"));
    if (this.#cancelMode === "stop") {
      stop();
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(() => resolve(stop()), 15));
  }

  #run(request: StructuredRequest, signal: AbortSignal): Promise<unknown> {
    this.requests.push(structuredClone(request));
    this.signals.push(signal);
    const step = this.#script.shift() ?? { output: this.#answer(request) };
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    let stop: (reason: Error) => void = () => undefined;
    return new Promise<unknown>((resolve, reject) => {
      stop = reject;
      if (step !== "ignore-abort") {
        if (signal.aborted) return stop(new Error("aborted"));
        signal.addEventListener("abort", () => stop(new Error("aborted")), { once: true });
      }
      this.#running.set(request.requestId, stop);
      if (step === "hang" || step === "ignore-abort") return;
      setTimeout(
        () => ("error" in step ? reject(step.error) : resolve(step.output)),
        this.#delayMs,
      );
    }).finally(() => {
      this.inFlight--;
      // a later call under the same ID replaced this entry; leave that one
      if (this.#running.get(request.requestId) === stop) this.#running.delete(request.requestId);
    });
  }
}
