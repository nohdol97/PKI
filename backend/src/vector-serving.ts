// What the server reads as the vector index (H01C3-R8): the bound index with only `status` laid over. An
// index marked stale (a missed notice, a restore) may point at other sources than it did, so it does not
// answer until a rebuild (a status that is not `ready` is passed on as it is); one whose active generation is in another embedding space than the bound
// embedder's cannot be compared with its queries. Every other call is the bound index's own.
import type { EmbeddingSpace, VectorIndex } from "@pki/contracts";
import { sameSpace } from "@pki/knowledge-engine";

export function servedVectorIndex(
  index: VectorIndex,
  state: { isStale: () => boolean; embeddingSpace: () => EmbeddingSpace | null },
): VectorIndex {
  return {
    status: async () => {
      const status = await index.status();
      if (status !== "ready") return status; // the empty index stays unavailable whatever its stale mark says
      if (state.isStale()) return "rebuilding";
      const wanted = state.embeddingSpace();
      const active = await index.embeddingSpace();
      if (wanted && active && !sameSpace(active, wanted)) {
        return { unavailable: "the index is in another embedding space than the embedder's" };
      }
      return status;
    },
    embeddingSpace: () => index.embeddingSpace(),
    appliedChangeSeq: () => index.appliedChangeSeq(),
    beginRebuild: (space) => index.beginRebuild(space),
    upsert: (items, changeSeq) => index.upsert(items, changeSeq),
    remove: (refs, changeSeq) => index.remove(refs, changeSeq),
    search: (query, k) => index.search(query, k),
  };
}
