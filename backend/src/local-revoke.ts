// The revocation of an approved location (I02B-R10, R49): the user's deletion of every source of it, in
// canonical transactions that commit together with their ledger lines. The first transaction answers the
// request (count check, up to `revoke.maxPerTransaction` sources, and the location's rows when that was
// all); the rest run behind it, one transaction per batch, the instance lock taken and given back each
// time and the event loop given a turn between. A batch the ledger refuses is rolled back alone and the
// location stays `revoking` with the reason. Nothing here reads a file.
import { errorClass, log } from "@pki/providers";
import type { CanonicalEntries } from "@pki/knowledge-engine";
import type { LocalRevokeRequest } from "@pki/contracts";
import {
  canonicalTransaction,
  closeLocation,
  LedgerDegradedError,
  LedgerLineUnwritableError,
  LOCAL_FILES_INSTANCE_ID,
  listLocations,
  liveSourceCount,
  readLocation,
  revokeBatch,
  type LocalLocation,
  type RevokeBatchResult,
  type SourceScope,
  type SqlDriver,
} from "@pki/storage";
import { tryLockInstance } from "./instance-lock.ts";
import { jsonlFileInstanceId } from "./jsonl-file-instances.ts";

/** The instance whose sources a location's revocation deletes, and so whose lock it takes (I02B-R41). */
export function instanceOfLocation(location: Pick<LocalLocation, "id" | "type">): string {
  return location.type === "jsonl-file"
    ? jsonlFileInstanceId(location.id)
    : LOCAL_FILES_INSTANCE_ID;
}

/** Where the sources of a location are: a JSONL file location's own instance, every namespace. */
export function sourceScopeOf(
  location: Pick<LocalLocation, "id" | "type">,
): SourceScope | undefined {
  return location.type === "jsonl-file"
    ? { instanceId: jsonlFileInstanceId(location.id), namespace: null }
    : undefined;
}

export type RevokeError =
  "not-found" | "count-mismatch" | "instance-busy" | "ledger-unwritable" | "ledger-degraded";
export type RevokeAnswer =
  | { state: "revoked"; revoked: number }
  | { state: "revoking"; remaining: number }
  | { error: RevokeError };

export interface LocalRevokeOptions {
  db: SqlDriver;
  entries: Pick<CanonicalEntries, "applyTombstone">;
  limits: () => { maxPerTransaction: number; lockWaitMs: number };
  /** Asks the running sync of the instance to stop at its next page (it continues from its cursor, so nothing is lost). */
  cancelSync: (instanceId: string) => void;
  /** Told once a location's last source is gone and its row with them (the instance of a JSONL file location is dropped). */
  onRevoked?: (location: LocalLocation) => void;
  /** Runs the next batch later, outside the request; a test steps it by hand. */
  schedule?: (step: () => unknown) => void;
  now?: () => string;
}

export interface LocalRevoke {
  revoke(request: LocalRevokeRequest): Promise<RevokeAnswer>;
  /** At start (I02B-R49): continues the revocation of every location that was `revoking`. */
  resume(): void;
}

const POLL_MS = 10;

export function createLocalRevoke(options: LocalRevokeOptions): LocalRevoke {
  const { db, entries } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const schedule =
    options.schedule ??
    ((step: () => unknown) =>
      void setImmediate(() => {
        Promise.resolve(step()).catch((error) =>
          log("local-revoke-failed", { error: errorClass(error) }),
        );
      }));

  /** The lock of the location's instance, asking a running sync to stop and waiting up to `revoke.lockWaitMs`. */
  async function lock(location: LocalLocation): Promise<(() => void) | undefined> {
    const instanceId = instanceOfLocation(location);
    const first = tryLockInstance(db, instanceId);
    if (first) return first;
    options.cancelSync(instanceId);
    const deadline = Date.now() + options.limits().lockWaitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const release = tryLockInstance(db, instanceId);
      if (release) return release;
    }
    return undefined;
  }

  /** One canonical transaction: the count check (first call only), then one batch. */
  function batch(
    location: LocalLocation,
    expected?: number,
  ): RevokeBatchResult | { error: "count-mismatch" | "ledger-unwritable" | "ledger-degraded" } {
    const id = location.id;
    const scope = sourceScopeOf(location);
    try {
      return canonicalTransaction(db, (tx) => {
        if (expected !== undefined && liveSourceCount(tx, id, scope) !== expected) {
          return { error: "count-mismatch" as const };
        }
        return revokeBatch(
          tx,
          id,
          options.limits().maxPerTransaction,
          (identity) => {
            entries.applyTombstone(tx, {
              identity,
              reason: "user-deleted",
              lastRevision: null,
              at: now(),
            });
          },
          scope,
        );
      });
    } catch (error) {
      if (error instanceof LedgerLineUnwritableError) return { error: "ledger-unwritable" };
      if (error instanceof LedgerDegradedError) return { error: "ledger-degraded" };
      throw error;
    }
  }

  /** The location's last batch went through: what hangs on its row (the instance) is dropped, never throwing into the revocation. */
  const revoked = (location: LocalLocation) => {
    try {
      options.onRevoked?.(location);
    } catch (error) {
      log("local-revoke-cleanup-failed", { error: errorClass(error) });
    }
  };

  /** A batch refused on a location already `revoking` keeps the reason on screen (I02B-R49). */
  const refused = (id: string, error: string) => {
    if (readLocation(db, id)?.state === "revoking") closeLocation(db, id, "revoking", error);
  };

  function chain(id: string): void {
    schedule(async () => {
      const location = readLocation(db, id);
      if (location?.state !== "revoking") return;
      const release = await lock(location);
      if (!release) return chain(id); // a sync still holds the instance: try again
      let result: ReturnType<typeof batch>;
      try {
        result = batch(location);
      } finally {
        release();
      }
      if ("error" in result) return refused(id, result.error);
      if (result.done) revoked(location);
      else chain(id);
    });
  }

  return {
    async revoke({ locationId, count }) {
      const location = readLocation(db, locationId);
      if (!location) return { error: "not-found" };
      const release = await lock(location);
      if (!release) return { error: "instance-busy" };
      let result: ReturnType<typeof batch>;
      try {
        result = batch(location, count);
      } finally {
        release();
      }
      if ("error" in result) {
        if (result.error !== "count-mismatch") refused(locationId, result.error);
        return { error: result.error };
      }
      if (result.done) {
        revoked(location);
        return { state: "revoked", revoked: result.deleted };
      }
      chain(locationId);
      return { state: "revoking", remaining: result.remaining };
    },
    resume() {
      for (const location of listLocations(db)) {
        if (location.state === "revoking") chain(location.id);
      }
    },
  };
}
