// Runs `vector-index.contract` against the memory test double.
import { MemoryVectorIndex } from "./memory-vector-index.ts";
import { vectorIndexContract } from "./vector-index.contract.ts";

vectorIndexContract("memory", () => new MemoryVectorIndex());
