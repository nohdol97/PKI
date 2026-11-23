// The registered projection kinds as ports for the projection jobs (I04-T04, I03-R7): what a
// `projection-remove` and a `projection-rebuild` do to the KnowledgeEngine and to the VectorIndex.
// The classifier, the stale-fence re-send, the marks and the cover of a rebuild are projection-jobs.ts's;
// here is what each call is made of.
//   - Engine: a removal is `removeSource({sourceId, version: coversVersion}, {version: fenceVersion},
//     changeSeq)`, the contract's removal of every version up to the cover. A stale fence is the
//     engine's own StaleFenceError, which the handler answers by sending again with the source's latest
//     version.
//   - Vector index: a removal names the refs of versions 1..cover (a ref names its source version,
//     vectorRefOf: the purge took the version rows). The index rejects a call whole when any ref moved
//     on to a later sequence; those refs were already removed or replaced after this removal was
//     registered, so the call is made again ref by ref and a stale ref is let go (a version at or below
//     the cover is never written again, so the later change can only be a removal). It never raises
//     StaleFenceError to the handler: a fence of a source's versions means nothing to a vector.
//   - A rebuild goes through `projections.rebuild`, queued with the notices, so it clears the stale mark.
import { StaleFenceError, type KnowledgeEngine, type VectorIndex } from "@pki/contracts";
import { ENGINE_KIND, vectorRefOf, VECTOR_KIND, type Projections } from "@pki/knowledge-engine";
import type { DerivativeRegistry, SqlDriver } from "@pki/storage";
import type { ProjectionPort, ProjectionPorts } from "./projection-jobs.ts";

export interface ProjectionPortsOptions {
  /** The registry whose kinds the ports bind: a port's mark is its registered kind's. */
  registry: DerivativeRegistry;
  db: SqlDriver;
  engine: KnowledgeEngine;
  vectorIndex: VectorIndex;
  projections: Pick<Projections, "rebuild">;
}

export function projectionPorts(options: ProjectionPortsOptions): ProjectionPorts {
  const { registry, engine, vectorIndex, projections } = options;
  const registered = (name: string) => {
    const kind = registry.kinds.find((k) => k.kind === name && k.storage === "projection");
    if (!kind) throw new Error(`the registry has no projection kind ${name}`);
    return kind;
  };

  const enginePort: ProjectionPort = {
    registered: registered(ENGINE_KIND),
    remove: ({ sourceId, coversVersion, fenceVersion, changeSeq }) =>
      engine.removeSource(
        { sourceId: String(sourceId), version: coversVersion },
        { version: fenceVersion },
        changeSeq,
      ),
    rebuild: ({ readSeq }) => projections.rebuild(ENGINE_KIND, readSeq),
  };

  const vectorPort: ProjectionPort = {
    registered: registered(VECTOR_KIND),
    async remove({ sourceId, coversVersion, changeSeq }) {
      const refs = Array.from({ length: coversVersion }, (_, i) => vectorRefOf(sourceId, i + 1));
      try {
        await vectorIndex.remove(refs, changeSeq);
      } catch (error) {
        if (!(error instanceof StaleFenceError)) throw error;
        for (const ref of refs) {
          try {
            await vectorIndex.remove([ref], changeSeq);
          } catch (single) {
            if (!(single instanceof StaleFenceError)) throw single;
          }
        }
      }
    },
    rebuild: ({ readSeq, signal }) => projections.rebuild(VECTOR_KIND, readSeq, signal),
  };

  return { [ENGINE_KIND]: enginePort, [VECTOR_KIND]: vectorPort };
}
