// The Phase 1 KnowledgeEngine (ADR 0003): no third-party engine is plugged in, so
// notifications are dropped and every capability is false.
import { UnsupportedCapabilityError, type KnowledgeEngine } from "@pki/contracts";

export class NullKnowledgeEngine implements KnowledgeEngine {
  readonly id = "null";

  capabilities() {
    return { propose: false, relatedContext: false, spanEvidence: false, temporal: false };
  }

  async health() {
    return { state: "not-implemented" } as const;
  }

  async appliedChangeSeq() {
    return null;
  }

  async upsertSource() {}

  async removeSource() {}

  async proposeKnowledge(): Promise<never> {
    throw new UnsupportedCapabilityError("propose");
  }

  async relatedContext(): Promise<never> {
    throw new UnsupportedCapabilityError("relatedContext");
  }

  async rebuild() {}
}
