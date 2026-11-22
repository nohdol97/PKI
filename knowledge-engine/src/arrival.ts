// What a Connector's change comes to in the canonical store (I01-R8 to R14). The
// caller opens the canonical transaction and the page's one transaction is its
// own; this takes one change and judges it:
// - an upsert and a scope change are judged by storage (saveSourceRecord,
//   saveScopeChange: the tombstone's door, the revision against the last accepted
//   one, the content hash). A scope that changes is then propagated as
//   `scope-changed`, widening or narrowing alike (I01-R12).
// - a delete or an access-revoked event goes to applyTombstone, which sets the
//   cover itself and propagates (I01-R11). Its revision is never the product's
//   version: both `last_revision`s are raised to the greatest of the event's, the
//   source's and the tombstone's, so a late older upsert meets the door.
// A change is read, never trusted for its time: the tombstone and the records take
// `at`, the product's clock, so no text of the Connector reaches them.
import type { Change } from "@pki/contracts";
import {
  findSourceId,
  raiseLastRevision,
  readLastRevision,
  readTombstoneState,
  saveScopeChange,
  saveSourceRecord,
  type CanonicalTx,
  type DerivativeRegistry,
} from "@pki/storage";
import { derivativeRegistry, propagateCanonical } from "./canonical-kinds.ts";
import { tombstoneEntries } from "./tombstone-entry.ts";

/** What one change did. Only `created`, `scope-updated` and `tombstoned` wrote anything. */
export type Accepted =
  | { outcome: "created"; sourceId: number; version: number }
  | { outcome: "scope-updated"; sourceId: number }
  | { outcome: "unchanged" | "stale" | "blocked" | "stale-tombstone" }
  | { outcome: "rejected"; code: "revision-conflict" }
  /** The purge's removals in the projections are jobs the tombstone's transaction registered (I04-R12). */
  | { outcome: "tombstoned"; sourceId: number };

export interface AcceptOptions {
  /** The change's scope is a user's own claim (an import, I01-R15). */
  scopeClaimed?: boolean;
}

export type AcceptChange = (
  tx: CanonicalTx,
  instanceId: string,
  change: Change,
  at: string,
  options?: AcceptOptions,
) => Accepted;

/** `acceptChange` over a registry: the one the composition root builds (entries.ts). */
export function createAcceptChange(registry: DerivativeRegistry): AcceptChange {
  const { applyTombstone } = tombstoneEntries(registry);
  return (tx, instanceId, change, at, options = {}) =>
    accept(registry, applyTombstone, tx, instanceId, change, at, options);
}

export const acceptChange: AcceptChange = createAcceptChange(derivativeRegistry);

function accept(
  registry: DerivativeRegistry,
  applyTombstone: ReturnType<typeof tombstoneEntries>["applyTombstone"],
  tx: CanonicalTx,
  instanceId: string,
  change: Change,
  at: string,
  options: AcceptOptions,
): Accepted {
  if (change.kind === "upsert") {
    const { record } = change;
    const saved = saveSourceRecord(
      tx,
      instanceId,
      {
        namespace: record.namespace,
        externalId: record.externalId,
        title: record.title,
        body: record.body,
        revision: record.revision,
        schemaVersion: record.schemaVersion,
        blocks: record.blocks,
        provenance: {
          sourceType: record.sourceType,
          sourceUrl: record.sourceUrl,
          author: record.author,
          participants: record.participants,
          threadId: record.threadId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          metadata: record.metadata,
        },
        accessScope: record.accessScope ?? null,
      },
      options,
    );
    if (saved.status === "scope-updated") {
      propagateCanonical(
        tx,
        { kind: "scope-changed", sourceId: saved.sourceId, from: saved.from, to: saved.to },
        at,
        registry,
      );
      return { outcome: "scope-updated", sourceId: saved.sourceId };
    }
    if (saved.status === "rejected") return { outcome: "rejected", code: saved.code };
    if (saved.status === "created") {
      return { outcome: "created", sourceId: saved.sourceId, version: saved.version };
    }
    return { outcome: saved.status };
  }
  if (change.kind === "scope-change") {
    const saved = saveScopeChange(tx, instanceId, change, options);
    if (saved.status === "scope-updated") {
      propagateCanonical(
        tx,
        { kind: "scope-changed", sourceId: saved.sourceId, from: saved.from, to: saved.to },
        at,
        registry,
      );
      return { outcome: "scope-updated", sourceId: saved.sourceId };
    }
    return { outcome: saved.status };
  }
  const identity = {
    connectorInstanceId: instanceId,
    namespace: change.namespace,
    externalId: change.externalId,
  };
  const found = findSourceId(tx, instanceId, change.namespace, change.externalId);
  const last = found === undefined ? null : readLastRevision(tx, found);
  // a delete below what the store holds is not applied and not hidden (I01-R11);
  // losing the authority to see a source is true whatever the order
  if (change.kind === "delete" && last !== null && change.revision < last) {
    return { outcome: "stale-tombstone" };
  }
  const lastRevision = Math.max(
    change.revision,
    last ?? 0,
    (found === undefined ? undefined : readTombstoneState(tx, found)?.lastRevision) ?? 0,
  );
  const result = applyTombstone(tx, {
    identity,
    reason: change.kind === "delete" ? "source-deleted" : "access-revoked",
    lastRevision,
    at,
  });
  raiseLastRevision(tx, result.sourceId, lastRevision);
  if (result.outcome === "unchanged") return { outcome: "unchanged" };
  return { outcome: "tombstoned", sourceId: result.sourceId };
}
