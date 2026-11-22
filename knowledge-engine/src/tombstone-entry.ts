// The tombstone entries (I04-R9, R12): the only way a deletion, an access
// revocation or a lift is written once I01-T02 and I04-T13 call them. The caller
// opens the canonical transaction; an entry never opens its own. applyTombstone
// finds the source by its identity (creating the row of one never seen, cover 0),
// lets storage judge the event against the stored tombstone and, on every outcome
// that changes it, closes the source's open jobs and propagates the change through
// the product registry, once, and hashes the identity of what the purge emptied
// (I04-R7). `unchanged` writes nothing. Ledger lines: I04-T10.
import {
  ensureTombstoneSource,
  hashSourceIdentity,
  recordTombstone,
  recordTombstoneLift,
  supersedeOpenJobs,
  type ApplyTombstone,
  type DerivativeRegistry,
  type LiftTombstone,
} from "@pki/storage";
import { derivativeRegistry, propagateCanonical } from "./canonical-kinds.ts";

/** One clock per request: the tombstone's, the jobs' and the record's. */
function requestTime(at: string): Date {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) throw new RangeError(`tombstone time is not a date: ${at}`);
  return when;
}

/**
 * The two entries over a registry (the composition root's: backend composition.ts). Nothing but
 * the registry differs between builds, so a deletion always reaches every registered kind.
 */
export function tombstoneEntries(registry: DerivativeRegistry): {
  applyTombstone: ApplyTombstone;
  liftTombstone: LiftTombstone;
} {
  const applyTombstone: ApplyTombstone = (tx, w) => {
    const when = requestTime(w.at);
    // a source never seen gets its row with the keyed hash, never the plain identity (I04-R7)
    const sourceId = ensureTombstoneSource(tx, w.identity);
    const { outcome, tombstone } = recordTombstone(tx, sourceId, w);
    const { coversVersion } = tombstone;
    if (outcome === "unchanged") return { outcome, sourceId, coversVersion };
    supersedeOpenJobs(tx, sourceId, when);
    // the change is what the tombstone holds now: a raised revision keeps its reason
    propagateCanonical(
      tx,
      { kind: tombstone.reason, sourceId, coversVersion, lastRevision: tombstone.lastRevision },
      w.at,
      registry,
    );
    // the purge left no version: what names the source is the hash from here on (I04-R7)
    hashSourceIdentity(tx, sourceId);
    return { outcome, sourceId, coversVersion };
  };

  /** A lift deletes and restores nothing: no propagation and no invalidation record. */
  const liftTombstone: LiftTombstone = (tx, sourceId, at) => {
    requestTime(at);
    return { outcome: recordTombstoneLift(tx, sourceId, at) };
  };
  return { applyTombstone, liftTombstone };
}

export const { applyTombstone, liftTombstone } = tombstoneEntries(derivativeRegistry);
