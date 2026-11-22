// The KnowledgeEngine as the backend holds it (I04-R13): wrapped by the registry, so what an engine
// finds is shown only through `visible`. `relatedContext` drops every hit whose source version is no
// longer stored, is covered by a tombstone, or whose scopes the policy does not allow for a search.
// The engine's own index may still hold a deleted source until its removal job runs (I04-R12), and
// this is what keeps it out of any result meanwhile. Every other member is the engine's own. If the
// policy cannot judge it throws, and the call rejects: a hit is never shown unjudged.
import type { ContextHit, ContextQuery, KnowledgeEngine } from "@pki/contracts";
import type { DerivativeRegistry, SqlDriver } from "@pki/storage";
import { ENGINE_KIND, projectionRowId } from "../projection-kinds.ts";

export function createVisibleEngine(
  engine: KnowledgeEngine,
  options: { db: SqlDriver; registry: DerivativeRegistry },
): KnowledgeEngine {
  const { db, registry } = options;
  return {
    id: engine.id,
    capabilities: () => engine.capabilities(),
    health: () => engine.health(),
    appliedChangeSeq: () => engine.appliedChangeSeq(),
    upsertSource: (input, fence, changeSeq) => engine.upsertSource(input, fence, changeSeq),
    removeSource: (ref, fence, changeSeq) => engine.removeSource(ref, fence, changeSeq),
    proposeKnowledge: (ref) => engine.proposeKnowledge(ref),
    rebuild: (sources, changeSeq) => engine.rebuild(sources, changeSeq),
    async relatedContext(query: ContextQuery): Promise<ContextHit[]> {
      const hits = await engine.relatedContext(query);
      // a hit names a source the engine knows by its text: a non-numeric id is no row of ours
      const rowOf = (hit: ContextHit) => ({
        kind: ENGINE_KIND,
        id: projectionRowId({ sourceId: Number(hit.ref.sourceId), version: hit.ref.version }),
      });
      const shown = new Set(
        registry
          .visible(
            db,
            hits.filter((h) => Number.isInteger(Number(h.ref.sourceId))).map(rowOf),
            "search",
          )
          .map((r) => r.id),
      );
      return hits.filter((hit) => shown.has(rowOf(hit).id));
    },
  };
}
