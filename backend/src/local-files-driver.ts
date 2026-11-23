// The local file driver (I02B-R20): the one object that starts the `local-files` work. It never reads a
// file or carries a change (I02B-R17): a watch signal only means "walk soon", debounced into at most one
// registered sync per `watch.maxWaitMs`. At start, in this order: a restored database stops every read
// location as `restored` (I02B-R34), a revocation left `revoking` goes on (I02B-R49), then one sync is
// registered when a location is read, and the watchers are placed. Whatever a watcher does or fails to do,
// the periodic sync and the next full walk give the same result.
import { watch as fsWatch } from "node:fs";
import { closeLocation, listLocations, type LocalLocation, type SqlDriver } from "@pki/storage";
import type { LocalRevoke } from "./local-revoke.ts";

export interface Watcher {
  close(): void;
}

/** Watches `path` and its folders; throws when it cannot (OS limit, permission). `onError` is a later failure. */
export type WatchFactory = (path: string, onSignal: () => void, onError: () => void) => Watcher;

/** The OS watcher: `fs.watch` with `recursive`. The event carries no name the driver uses. */
export const nodeWatch: WatchFactory = (path, onSignal, onError) => {
  const watcher = fsWatch(path, { recursive: true }, () => onSignal());
  watcher.on("error", onError);
  return { close: () => watcher.close() };
};

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const nodeTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface LocalFilesDriverOptions {
  db: SqlDriver;
  /** Registers one sync of the `local-files` instance (the schedule's "run now": one already waiting is not doubled). */
  registerSync: () => void;
  revoke: Pick<LocalRevoke, "resume">;
  watch: WatchFactory;
  timers: Timers;
  /** Milliseconds, a clock the debounce reads. */
  now: () => number;
  limits: () => { quietMs: number; maxWaitMs: number };
}

export interface LocalFilesDriver {
  /** `restored`: the start applied ledger lines or set the ledger aside (I02B-R34). */
  start(restored: boolean): void;
  /** The set of read locations may have changed: watchers are placed for it. */
  refresh(): void;
  watching(locationId: string): boolean;
  stop(): void;
}

/** A location that is read, or that returns to being read by itself at the next pass. */
const isReadable = (l: LocalLocation) =>
  l.type === "folder" &&
  (l.state === "active" || l.state === "needs-confirmation" || l.state === "unavailable");

const isRead = (l: LocalLocation) =>
  l.type === "folder" && (l.state === "active" || l.state === "needs-confirmation");

export function createLocalFilesDriver(options: LocalFilesDriverOptions): LocalFilesDriver {
  const { db, timers } = options;
  const watchers = new Map<string, Watcher>();
  /** Locations a watch could not be placed on or failed: not tried again until they leave the read set. */
  const failed = new Set<string>();
  let pending: { first: number; handle: unknown } | undefined;
  /** When a signal last registered a sync: the next is no sooner than `maxWaitMs` after it. */
  let lastFire: number | undefined;
  let stopped = false;

  function fire() {
    pending = undefined;
    lastFire = options.now();
    if (!stopped) options.registerSync();
  }

  function signal() {
    if (stopped) return;
    const { quietMs, maxWaitMs } = options.limits();
    const at = options.now();
    const first = pending?.first ?? at;
    if (pending) timers.clear(pending.handle);
    // quiet for `quietMs`, but never later than `maxWaitMs` after the first signal of this wait, and
    // never sooner than `maxWaitMs` after the sync the last wait registered
    const due = Math.min(at + quietMs, first + maxWaitMs);
    const earliest = lastFire === undefined ? at : lastFire + maxWaitMs;
    pending = { first, handle: timers.set(fire, Math.max(0, Math.max(due, earliest) - at)) };
  }

  function refresh() {
    if (stopped) return;
    const read = listLocations(db).filter(isRead);
    const ids = new Set(read.map((l) => l.id));
    for (const [id, watcher] of watchers) {
      if (!ids.has(id)) {
        watcher.close();
        watchers.delete(id);
      }
    }
    for (const id of failed) if (!ids.has(id)) failed.delete(id);
    for (const location of read) {
      if (watchers.has(location.id) || failed.has(location.id)) continue;
      try {
        watchers.set(
          location.id,
          options.watch(location.realPath, signal, () => {
            watchers.get(location.id)?.close();
            watchers.delete(location.id);
            failed.add(location.id);
          }),
        );
      } catch {
        // a location that cannot be watched is shown unwatched and gets the periodic sync only (I02B-R20)
        failed.add(location.id);
      }
    }
  }

  return {
    start(restored) {
      if (restored) {
        // before any sync is registered: the restored rows are `active`, the folders may be revoked ones
        for (const location of listLocations(db)) {
          if (isReadable(location)) closeLocation(db, location.id, "paused", "restored");
        }
      }
      options.revoke.resume();
      if (listLocations(db).some(isRead)) options.registerSync();
      refresh();
    },
    refresh,
    watching: (id) => watchers.has(id),
    stop() {
      stopped = true;
      if (pending) timers.clear(pending.handle);
      pending = undefined;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
