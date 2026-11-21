// The product's VectorIndex in Phase 1 (V01-R15, ADR 0004): no native vector module
// ships yet, so every call reports unavailable and search falls back to keywords.
import { AdapterUnavailableError, type VectorIndex } from "@pki/contracts";

const REASON = "no vector index module in this build";

const unavailable = async (): Promise<never> => {
  throw new AdapterUnavailableError(REASON);
};

export class EmptyVectorIndex implements VectorIndex {
  async status() {
    return { unavailable: REASON };
  }
  embeddingSpace = unavailable;
  appliedChangeSeq = unavailable;
  reset = unavailable;
  upsert = unavailable;
  remove = unavailable;
  search = unavailable;
}
