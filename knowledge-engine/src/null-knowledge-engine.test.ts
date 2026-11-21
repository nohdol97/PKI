// V01-R16, ADR 0003: the Phase 1 engine does nothing, claims no capability, and
// says so; notifications are accepted and dropped.
import { UnsupportedCapabilityError, type KnowledgeEngine } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { NullKnowledgeEngine } from "./null-knowledge-engine.ts";

describe("NullKnowledgeEngine", () => {
  const engine: KnowledgeEngine = new NullKnowledgeEngine();
  const ref = { sourceId: "a", version: 1 };
  const input = { ref, title: "t", body: "b" };

  it("claims no capability and reports not-implemented", async () => {
    expect(Object.values(engine.capabilities())).toEqual([false, false, false, false]);
    expect(await engine.health()).toEqual({ state: "not-implemented" });
  });

  it("rejects the capability methods as unsupported", async () => {
    await expect(engine.proposeKnowledge(ref)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(engine.relatedContext({ text: "b", limit: 1 })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });

  it("accepts notifications without holding anything", async () => {
    await engine.upsertSource(input, { version: 1 }, 1);
    await engine.removeSource(ref, { version: 1 }, 2);
    async function* none() {}
    await engine.rebuild(none(), 3);
    expect(await engine.appliedChangeSeq()).toBeNull();
  });
});
