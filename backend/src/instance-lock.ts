// The per-instance lock (I01-R21): one sync or import of an instance at a time. Kept apart from the
// management module so the page store can take the lock of another instance it writes into.
import type { SqlDriver } from "@pki/storage";

const locks = new WeakMap<SqlDriver, Set<string>>();

/**
 * Takes an instance's lock, or returns undefined when it is held (I01-R21): one sync or
 * import per instance at a time. Call the returned function once, in a `finally`, on
 * every path. Locks are kept per database handle, so every taker must hold the same one.
 */
export function tryLockInstance(db: SqlDriver, instanceId: string): (() => void) | undefined {
  let held = locks.get(db);
  if (!held) locks.set(db, (held = new Set()));
  if (held.has(instanceId)) return undefined;
  held.add(instanceId);
  const set = held;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    set.delete(instanceId);
  };
}
