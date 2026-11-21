// Runs `engine.contract` against the memory test double.
import { knowledgeEngineContract } from "./engine.contract.ts";
import { MemoryKnowledgeEngine } from "./memory-knowledge-engine.ts";

knowledgeEngineContract("memory", () => new MemoryKnowledgeEngine());
