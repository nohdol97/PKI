// The registry's read checks the Ask path calls (X01-R12~R14), in the manner of read-gate.ts: a source version
// is judged as `{ kind: "source", id }` for the purpose the call names, and a registry that cannot judge
// throws, so the request fails closed: nothing is shown unjudged. Which checks run and when is ask.ts's.
import {
  readSourceVersion,
  type DerivativeRegistry,
  type ScopePurpose,
  type SqlDriver,
  type StoredSourceVersion,
} from "@pki/storage";

export interface AskReads {
  /** The version row ids the policy shows for `purpose` (a deleted or hidden one is not in the set). */
  shown(versionIds: readonly number[], purpose: ScopePurpose): Set<number>;
  /** Whether the policy lets the sources of these versions be put in one call (I04-R14). */
  combinable(versions: readonly { sourceId: number; version: number }[]): boolean;
  /** The stored title and body; undefined when the row is gone. */
  version(versionId: number): StoredSourceVersion | undefined;
}

export function createAskReads(db: SqlDriver, registry: DerivativeRegistry): AskReads {
  return {
    shown: (versionIds, purpose) =>
      new Set(
        registry
          .visible(
            db,
            versionIds.map((id) => ({ kind: "source", id: String(id) })),
            purpose,
          )
          .map((ref) => Number(ref.id)),
      ),
    combinable: (versions) =>
      registry.combinable(
        db,
        versions.map((v) => ({ sourceId: v.sourceId, version: v.version })),
      ),
    version: (versionId) => readSourceVersion(db, versionId),
  };
}
