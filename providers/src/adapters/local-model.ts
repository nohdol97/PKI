// Local-model Provider (V01-R11, ADR 0005 item 3): the contract only. Every call
// answers "not implemented"; it runs nothing and reports no structured output, so
// the Broker never calls it in Phase 1. Its egress is local (ADR 0014).
import {
  ProviderError,
  type AuthStatus,
  type HealthStatus,
  type LLMProvider,
  type LLMResponse,
  type ProviderCapabilities,
  type ProviderInfo,
  type StructuredResponse,
} from "@pki/contracts";

export const LOCAL_MODEL_NOT_IMPLEMENTED = "not-implemented";

export class LocalModelProvider implements LLMProvider {
  readonly id = "local-model" as const;
  /** No runtime is chosen; "http" is a placeholder the Broker's CLI gate does not apply to. */
  readonly transport = "http" as const;

  async detect(): Promise<ProviderInfo> {
    return { installed: false };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    return "unknown";
  }

  async checkHealth(): Promise<HealthStatus> {
    return { state: "unavailable", reason: LOCAL_MODEL_NOT_IMPLEMENTED };
  }

  getCapabilities(): ProviderCapabilities {
    return { structuredOutput: false, cancel: false, egress: "local" };
  }

  async generate(): Promise<LLMResponse> {
    throw new ProviderError(LOCAL_MODEL_NOT_IMPLEMENTED, { retryable: false });
  }

  async generateStructured(): Promise<StructuredResponse> {
    throw new ProviderError(LOCAL_MODEL_NOT_IMPLEMENTED, { retryable: false });
  }

  async cancel(): Promise<void> {}
}
