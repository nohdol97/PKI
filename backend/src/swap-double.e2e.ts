// Test-build-only swapped configuration for a running backend (V01-T17, V01-R17; spec
// "T17이 넘기는 것" 3). swap-double.hook.e2e.ts, loaded ahead of the dev backend's
// entry (`node --import` before dev.ts in the browser E2E), makes this module's
// `productProviders` and `productAdapters` stand in for the composition point's:
// a Provider double under `local-model` and the fake embedder. Unlike the V02-T11
// double (v02-double.e2e.ts), it records no consent and no default Provider: the
// screens test chooses and consents through Settings, as a user would (T10 handoff 11).
// Nothing else of the backend changes. The `.e2e.ts` name keeps it a test module
// (module boundary; Playwright's testIgnore); the build check refuses it by path.
import type { EmbeddingProvider, LLMProvider } from "@pki/contracts";
import { EmptyVectorIndex } from "@pki/storage/adapters";
import { FakeEmbedder, FakeProvider } from "@pki/testkit";

/** Stands in for composition.ts `productProviders`: the Provider double only. */
export function productProviders(): readonly LLMProvider[] {
  return [
    new FakeProvider({
      id: "local-model",
      transport: "http",
      answer: (r) =>
        r.taskKind === "extract" ? { items: [], facts: [], relations: [] } : { reply: "ok" },
    }),
  ];
}

/** Stands in for composition.ts `productAdapters`: the product's empty vector index, the fake embedder. */
export function productAdapters(): { vectorIndex: EmptyVectorIndex; embedder: EmbeddingProvider } {
  return { vectorIndex: new EmptyVectorIndex(), embedder: new FakeEmbedder() };
}
