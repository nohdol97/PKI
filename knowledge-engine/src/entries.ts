// The entries that run the derivative registry (I04-R2, R9), bound to one registry. The composition
// root builds the product's registry (backend composition.ts `productRegistry`: the configured policy
// and the marks of the projections it binds) and hands the entries made from it to the paths that store
// a change, delete a source or lift a tombstone. The entries exported by name from the other files of
// this package are the same functions over `derivativeRegistry`, the registry with the placeholder
// policy and no marks (canonical-kinds.ts): what a test builds on when it needs no composition.
import type { DerivativeRegistry } from "@pki/storage";
import { createAcceptChange, type AcceptChange } from "./arrival.ts";
import { derivativeRegistry } from "./canonical-kinds.ts";
import { createPruneVersions, type PruneVersions } from "./prune-versions.ts";
import { createPropagateNewVersion, type PropagateNewVersion } from "./propagation.ts";
import { createUserDelete, type UserDelete } from "./projections.ts";
import { tombstoneEntries } from "./tombstone-entry.ts";

export interface CanonicalEntries {
  readonly registry: DerivativeRegistry;
  applyTombstone: ReturnType<typeof tombstoneEntries>["applyTombstone"];
  liftTombstone: ReturnType<typeof tombstoneEntries>["liftTombstone"];
  acceptChange: AcceptChange;
  propagateNewVersion: PropagateNewVersion;
  userDelete: UserDelete;
  pruneVersions: PruneVersions;
}

export function createCanonicalEntries(registry: DerivativeRegistry): CanonicalEntries {
  return {
    registry,
    ...tombstoneEntries(registry),
    acceptChange: createAcceptChange(registry),
    propagateNewVersion: createPropagateNewVersion(registry),
    userDelete: createUserDelete(registry),
    pruneVersions: createPruneVersions(registry),
  };
}

/** The entries over `derivativeRegistry`: what a path without a composition root runs. */
export const defaultEntries: CanonicalEntries = createCanonicalEntries(derivativeRegistry);
