// The tombstone entries (I04-R9, R12): the only way a deletion, an access
// revocation or a lift is written once I01-T02 and I04-T13 call them. The caller
// opens the canonical transaction; an entry never opens its own. applyTombstone
// finds the source by its identity (creating the row of one never seen, cover 0),
// lets storage judge the event against the stored tombstone and, on every outcome
// that changes it, closes the source's open jobs and propagates the change through
// the product registry, once. `unchanged` writes nothing. Ledger lines: I04-T10.
import {
  ensureSourceId,
  recordTombstone,
  recordTombstoneLift,
  supersedeOpenJobs,
  type ApplyTombstone,
  type LiftTombstone,
} from "@pki/storage";
import { propagateCanonical } from "./canonical-kinds.ts";

/** One clock per request: the tombstone's, the jobs' and the record's. */
function requestTime(at: string): Date {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) throw new RangeError(`tombstone time is not a date: ${at}`);
  return when;
}

export const applyTombstone: ApplyTombstone = (tx, w) => {
  const when = requestTime(w.at);
  const { connectorInstanceId, namespace, externalId } = w.identity;
  const sourceId = ensureSourceId(tx, connectorInstanceId, namespace, externalId);
  const { outcome, tombstone } = recordTombstone(tx, sourceId, w);
  const { coversVersion } = tombstone;
  if (outcome === "unchanged") return { outcome, sourceId, coversVersion };
  supersedeOpenJobs(tx, sourceId, when);
  // the change is what the tombstone holds now: a raised revision keeps its reason
  propagateCanonical(
    tx,
    { kind: tombstone.reason, sourceId, coversVersion, lastRevision: tombstone.lastRevision },
    w.at,
  );
  return { outcome, sourceId, coversVersion };
};

/** A lift deletes and restores nothing: no propagation and no invalidation record. */
export const liftTombstone: LiftTombstone = (tx, sourceId, at) => {
  requestTime(at);
  return { outcome: recordTombstoneLift(tx, sourceId, at) };
};
