// Runs `engine.contract` against the memory test doubles, with and without the propose capability.
import { knowledgeEngineContract } from "./engine.contract.ts";
import { MemoryKnowledgeEngine } from "./memory-knowledge-engine.ts";
import { ProposingKnowledgeEngine } from "./proposing-knowledge-engine.ts";

knowledgeEngineContract("memory", () => new MemoryKnowledgeEngine());
knowledgeEngineContract(
  "memory with propose",
  () =>
    new ProposingKnowledgeEngine(({ ref, body }) => [
      {
        kind: "fact",
        ref,
        item: { type: "Project", name: "alpha", existingItemId: null },
        factKind: "target_date",
        value: "2026-12-05",
        epistemic: "explicit",
        quote: body,
      },
    ]),
);
