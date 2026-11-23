// RVF-R1: the question's text reaches an embedder through the same entrance as a document's (H01C3-R6).
// An embedder that is not local is asked of the egress policy first; a denial is a `vector` that is
// unavailable with a fixed reason (the policy's own reason text is not carried), never another embedder.
import { AdapterUnavailableError, type EmbeddingProvider } from "@pki/contracts";
import {
  denyExternalEmbedding,
  embedWithinPolicy,
  EmbeddingEgressDeniedError,
  type EmbeddingEgressPolicy,
} from "@pki/providers";

export function queryEmbedding(
  embedder: Pick<EmbeddingProvider, "status" | "embed" | "describe">,
  policy: EmbeddingEgressPolicy = denyExternalEmbedding,
): Pick<EmbeddingProvider, "status" | "embed"> {
  return {
    status: () => embedder.status(),
    embed: async (texts, kind, signal) => {
      try {
        return await embedWithinPolicy(embedder as EmbeddingProvider, policy, texts, kind, signal);
      } catch (e) {
        if (e instanceof EmbeddingEgressDeniedError) {
          throw new AdapterUnavailableError("embedding egress denied");
        }
        throw e;
      }
    },
  };
}
