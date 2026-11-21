// The one entrance for upper code that embeds texts (V01-R14, ARCHITECTURE 5.2,
// ADR 0014). An embedder whose egress is not exactly 'local' sends texts out, so
// the embedding egress policy is asked before every call, and a denial (or any
// answer other than an allowance) means the embedder is not called.
import type { DataClassification, EmbeddingKind, EmbeddingProvider } from "@pki/contracts";

export interface EmbeddingEgressInput {
  modelId: string;
  classification: DataClassification;
}

export interface EmbeddingEgressPolicy {
  decide(input: EmbeddingEgressInput): { allowed: true } | { allowed: false; reason: string };
}

/**
 * Phase 1 has no consent path for embedding (T08's rules cover LLM task kinds), so
 * every external embedding is denied. A fork that adds a remote embedder binds a
 * policy backed by the consent rules in its place.
 */
export const denyExternalEmbedding: EmbeddingEgressPolicy = {
  decide: () => ({ allowed: false, reason: "no-embedding-consent-path" }),
};

/** Carries a reason code only, never the texts. */
export class EmbeddingEgressDeniedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`embedding egress denied: ${reason}`);
    this.name = "EmbeddingEgressDeniedError";
    this.reason = reason;
  }
}

export async function embedWithinPolicy(
  embedder: EmbeddingProvider,
  policy: EmbeddingEgressPolicy,
  texts: readonly string[],
  kind: EmbeddingKind,
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const { modelId, egress } = embedder.describe();
  if (egress !== "local") {
    // Plain texts carry no source IDs to grade, so they are general (closed side, V01-R8).
    const decision = policy.decide({ modelId, classification: "general" });
    if (decision.allowed !== true) {
      throw new EmbeddingEgressDeniedError(
        decision.allowed === false && typeof decision.reason === "string"
          ? decision.reason
          : "invalid-decision",
      );
    }
  }
  return embedder.embed(texts, kind, signal);
}
