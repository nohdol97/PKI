// LLM Provider adapter (ARCHITECTURE 5.1, V01-R8). Upper code sends the Broker a
// BrokerRequest of IDs only; the Broker builds the LLMRequest a Provider receives,
// so the text, its data classification and the call kind are never the caller's.
import { z } from "zod";
import type { HealthStatus } from "./connector.ts";

/**
 * Data classes, least strict first (ADR 0014). "synthetic" only by the synthetic
 * manifest; everything else in the public repository is "general".
 */
export const DATA_CLASSES = ["synthetic", "general"] as const;
export type DataClassification = (typeof DATA_CLASSES)[number];

export const PROVIDER_IDS = ["claude-code", "codex", "openai-compatible", "local-model"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * How a Provider's calls are labelled on screens and in history (ADR 0014): a CLI
 * runs locally but sends the request to its vendor, so it is external. Any name
 * other than the local-model Provider, an unknown one included, counts as external.
 */
export function providerEgress(provider: string): "external" | "local" {
  return provider === "local-model" ? "local" : "external";
}

export const TASK_KINDS = ["extract", "connection-test", "wiki-summary"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** A canonical-store row ID as the API carries it: a positive decimal integer. */
const RowId = z.string().regex(/^[1-9][0-9]*$/);

/**
 * Upper code → Broker. Strict at every level: a field for text, instructions,
 * classification or call kind makes the whole request invalid.
 */
export const BrokerRequestSchema = z.strictObject({
  taskKind: z.enum(TASK_KINDS),
  sourceVersionIds: z.array(RowId),
  candidateItemIds: z.array(z.string().min(1)),
  origin: z.union([
    // the lease token the runner holds the running job by (V02-T03, I03-R2): only
    // the current one calls
    z.strictObject({ jobId: RowId, leaseToken: RowId }),
    z.strictObject({ userActionId: z.string().min(1) }),
  ]),
  schemaVersion: z.int().positive(),
  budget: z.strictObject({
    timeoutMs: z.int().positive(),
    maxOutputTokens: z.int().positive().optional(),
  }),
  retryable: z.boolean(),
});
export type BrokerRequest = z.infer<typeof BrokerRequestSchema>;

/** The allowed egress decision the Broker obtained for this call (ADR 0014, T08). */
export interface EgressDecision {
  readonly allowed: true;
  readonly destination: string;
  readonly policyVersion: string;
}

/** Text the Broker read from the canonical store (or the build material); data, never instructions. */
export interface UntrustedDocument {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/** Broker → Provider. Every field is the Broker's. */
export interface LLMRequest {
  readonly requestId: string;
  readonly taskKind: TaskKind;
  readonly trigger: "user" | "background";
  readonly dataClassification: DataClassification;
  readonly egress: EgressDecision;
  readonly schemaVersion: number;
  readonly budget: BrokerRequest["budget"];
  readonly retryable: boolean;
  readonly input: {
    /** A code constant chosen by task kind and schema version. */
    readonly instructions: string;
    readonly untrustedDocuments: readonly UntrustedDocument[];
    readonly candidates: readonly { readonly id: string; readonly name: string }[];
  };
  /**
   * For a CLI Provider only, from the execution conditions (ARCHITECTURE 3.1): the
   * argument profile (a code constant's name) the CLI must run with, and whether
   * this combination's isolation was verified. The development exception's calls
   * are "unverified" and use the minimal profile.
   */
  readonly execution?: {
    readonly profile: string;
    readonly isolation: "verified" | "unverified";
    /**
     * The model a verified combination runs: the verified list entry's, since an
     * R02 verdict holds for the model it ran (V01-T10). The unverified minimal
     * profile runs the CLI's default model and carries none.
     */
    readonly model?: string;
    /**
     * The absolute path this attempt's version query ran (the Provider's own
     * `detect().path`, carried by the Broker): the CLI runs that executable and
     * looks for no other, so the version judged is the version that runs.
     */
    readonly executable?: string;
  };
}

/** A request for output matching a JSON Schema; the Broker validates what comes back. */
export interface StructuredRequest extends LLMRequest {
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export interface LLMResponse {
  readonly text: string;
}

export interface StructuredResponse {
  readonly output: unknown;
}

export interface ProviderInfo {
  readonly installed: boolean;
  readonly path?: string;
  readonly version?: string;
  /**
   * Found but cannot be run here: its run folder root (in the data directory) is
   * not a private directory of this user (V01-T10). Nothing ran; no version.
   */
  readonly problem?: "cli-runs-root-refused";
}

/** A Provider that has no way to tell answers "unknown"; it never reads credential files. */
export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface ProviderCapabilities {
  readonly structuredOutput: boolean;
  readonly cancel: boolean;
  readonly egress: "external" | "local";
}

export interface LLMProvider {
  readonly id: ProviderId;
  readonly transport: "cli" | "http";
  /** Installed or not, path, version; only fixed arguments that need no gate. */
  detect(): Promise<ProviderInfo>;
  checkAuthentication(): Promise<AuthStatus>;
  /** Never calls the model; the model-calling check is the connection test, through the Broker. */
  checkHealth(): Promise<HealthStatus>;
  getCapabilities(): ProviderCapabilities;
  /** Rejects when `signal` aborts. */
  generate(request: LLMRequest, signal: AbortSignal): Promise<LLMResponse>;
  generateStructured(request: StructuredRequest, signal: AbortSignal): Promise<StructuredResponse>;
  /** Stops a running request; an unknown ID is not an error. */
  cancel(requestId: string): Promise<void>;
  /**
   * Backend shutdown: stops every running request (a CLI's whole process tree),
   * waits for them and refuses new ones. Optional: a Provider with nothing that
   * outlives the backend has none.
   */
  close?(): Promise<void>;
}

/**
 * A Provider failure the Broker can act on. `retryable` says whether repeating
 * the same request may succeed. The message is for developers only: the Broker
 * never copies it into results or history, since a CLI or server may echo input.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options: { retryable: boolean }) {
    super(message);
    this.name = "ProviderError";
    this.retryable = options.retryable;
  }
}

/** The Provider's rate-limit response, with the wait it asked for when it gave one. */
export class ProviderRateLimitError extends ProviderError {
  readonly retryAfterMs: number | undefined;
  constructor(options: { retryAfterMs?: number } = {}) {
    super("rate limited", { retryable: true });
    this.name = "ProviderRateLimitError";
    this.retryAfterMs = options.retryAfterMs;
  }
}
