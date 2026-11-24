// Notification lines (P02-R1, R5, R8, R11): one row per (active Insight, `changed_at`) saying how the change was
// told, and one per digest window. A row holds ids, codes and times only; the words are read from the Insight when
// they are shown. The OS channel's state (`os_state`) is written here and only here: `queued` with the line,
// `handed` in the transaction that precedes the message, then the shell's answer. Every write bumps the one
// sequence number the screens poll (P02-R14, `notify_state`).
import type { SqlDriver, SqlRow } from "./sql-driver.ts";
import { readSetting } from "./settings.ts";

export type NotificationKind = "insight" | "daily" | "weekly";
export type NotificationStatus = "sent" | "digest" | "deferred" | "dismissed" | "withdrawn";
export type NotificationReason = "low-confidence" | "below-threshold" | "repeat" | "muted";
export type OsState =
  "none" | "queued" | "handed" | "shown" | "unavailable" | "failed" | "cancelled";

export interface StoredNotification {
  id: number;
  kind: NotificationKind;
  insightId: number | null;
  /** The Insight's `changed_at` when the line was made ("" when it had none); null for a digest line. */
  insightChangedAt: string | null;
  status: NotificationStatus;
  reason: NotificationReason | null;
  notBefore: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  osState: OsState;
  createdAt: string;
  readAt: string | null;
}

const fromRow = (r: SqlRow): StoredNotification => ({
  id: r.id as number,
  kind: r.kind as NotificationKind,
  insightId: r.insight_id as number | null,
  insightChangedAt: r.insight_changed_at as string | null,
  status: r.status as NotificationStatus,
  reason: r.reason as NotificationReason | null,
  notBefore: r.not_before as string | null,
  windowStart: r.window_start as string | null,
  windowEnd: r.window_end as string | null,
  osState: r.os_state as OsState,
  createdAt: r.created_at as string,
  readAt: r.read_at as string | null,
});

const touch = (db: SqlDriver) => db.run("UPDATE notify_state SET seq = seq + 1 WHERE id = 1");

/** The sequence number of the notification lines' changes. */
export const readNotifySeq = (db: SqlDriver): number =>
  db.all("SELECT seq FROM notify_state WHERE id = 1")[0]?.seq as number;

export function readNotification(db: SqlDriver, id: number): StoredNotification | undefined {
  const row = db.all("SELECT * FROM notifications WHERE id = ?", [id])[0];
  return row && fromRow(row);
}

export const listNotifications = (db: SqlDriver): StoredNotification[] =>
  db.all("SELECT * FROM notifications ORDER BY id").map(fromRow);

/** The ids of active Insights with no line for their current content, oldest first, at most `limit`. */
export function unnotifiedActiveInsightIds(db: SqlDriver, limit: number): number[] {
  return db
    .all(
      `SELECT i.id FROM insights i
        WHERE i.state = 'active' AND NOT EXISTS
          (SELECT 1 FROM notifications n
            WHERE n.insight_id = i.id AND n.insight_changed_at = coalesce(i.changed_at, ''))
        ORDER BY i.id LIMIT ?`,
      [limit],
    )
    .map((r) => r.id as number);
}

/**
 * Writes the line of one Insight content; none (undefined) when it already has one. A `sent` line starts with
 * its OS channel `queued`, any other with none.
 */
export function insertInsightNotification(
  db: SqlDriver,
  input: {
    insightId: number;
    changedAt: string;
    status: "sent" | "digest" | "withdrawn";
    reason: NotificationReason | null;
    at: string;
  },
): number | undefined {
  const { changes, lastInsertRowid } = db.run(
    `INSERT INTO notifications
       (kind, dedupe_key, insight_id, insight_changed_at, status, reason, os_state, created_at)
     VALUES ('insight', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      `insight:${input.insightId}:${input.changedAt}`,
      input.insightId,
      input.changedAt,
      input.status,
      input.reason,
      input.status === "sent" ? "queued" : "none",
      input.at,
    ],
  );
  if (changes === 0) return undefined;
  touch(db);
  return lastInsertRowid;
}

/**
 * The lines of the Insight told immediately made at or after `since`: no reason, or an OS channel that left `none`
 * (a line that entered the feed as `sent` keeps it when it is later demoted to the digest); not withdrawn.
 */
export function immediateLinesSince(
  db: SqlDriver,
  insightId: number,
  since: string,
): { insightId: number; immediate: true; at: string }[] {
  return db
    .all(
      `SELECT created_at FROM notifications
        WHERE insight_id = ? AND (reason IS NULL OR os_state <> 'none') AND status <> 'withdrawn'
          AND created_at >= ?`,
      [insightId, since],
    )
    .map((r) => ({ insightId, immediate: true as const, at: r.created_at as string }));
}

/** The end of the last window of the digest kind, or null while it has none. */
export function lastDigestEnd(db: SqlDriver, kind: "daily" | "weekly"): string | null {
  return (db.all("SELECT max(window_end) AS e FROM notifications WHERE kind = ?", [kind])[0]?.e ??
    null) as string | null;
}

/** When the oldest Insight line was made, or null with none. */
export function firstInsightLineAt(db: SqlDriver): string | null {
  return (db.all("SELECT min(created_at) AS t FROM notifications WHERE kind = 'insight'")[0]?.t ??
    null) as string | null;
}

/** How many Insight lines were made in the window `[start, end)`, those withdrawn left out. */
export function countInsightLinesIn(db: SqlDriver, start: string, end: string): number {
  return db.all(
    `SELECT count(*) AS n FROM notifications
      WHERE kind = 'insight' AND status <> 'withdrawn' AND created_at >= ? AND created_at < ?`,
    [start, end],
  )[0]?.n as number;
}

/** Writes the line of one digest window (the key is its kind and start); none when it exists. Its OS channel is `queued`. */
export function insertDigestNotification(
  db: SqlDriver,
  input: { kind: "daily" | "weekly"; windowStart: string; windowEnd: string; at: string },
): number | undefined {
  const { changes, lastInsertRowid } = db.run(
    `INSERT INTO notifications
       (kind, dedupe_key, status, window_start, window_end, os_state, created_at)
     VALUES (?, ?, 'sent', ?, ?, 'queued', ?) ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      input.kind,
      `${input.kind}:${input.windowStart}`,
      input.windowStart,
      input.windowEnd,
      input.at,
    ],
  );
  if (changes === 0) return undefined;
  touch(db);
  return lastInsertRowid;
}

/** The deferred lines whose time has come, oldest first. */
export function dueDeferredNotifications(db: SqlDriver, now: string): StoredNotification[] {
  return db
    .all("SELECT * FROM notifications WHERE status = 'deferred' AND not_before <= ? ORDER BY id", [
      now,
    ])
    .map(fromRow);
}

/**
 * A line goes back to the feed (P02-R4). Its time having come, it takes the OS channel once more; the user's own
 * "take it back" (`queueOs` false) leaves the channel as it is, since the user is looking at the feed.
 */
export function returnNotification(db: SqlDriver, id: number, queueOs = true): boolean {
  const done =
    db.run(
      `UPDATE notifications SET status = 'sent', not_before = NULL, read_at = NULL,
         os_state = CASE WHEN ? THEN 'queued' ELSE os_state END
        WHERE id = ? AND status = 'deferred'`,
      [queueOs ? 1 : 0, id],
    ).changes === 1;
  if (done) touch(db);
  return done;
}

/** The line leaves the feed, the digest and the timeline; its waiting OS message is cancelled (P02-R7). */
export function withdrawNotification(db: SqlDriver, id: number): boolean {
  const done =
    db.run(
      `UPDATE notifications SET status = 'withdrawn', not_before = NULL,
         os_state = CASE WHEN os_state = 'queued' THEN 'cancelled' ELSE os_state END
        WHERE id = ? AND status <> 'withdrawn'`,
      [id],
    ).changes === 1;
  if (done) touch(db);
  return done;
}

/** The user muted the Insight after the line was made: it stays in the digest only, its OS message is cancelled (P02-R7). */
export function demoteNotificationToDigest(db: SqlDriver, id: number): boolean {
  const done =
    db.run(
      `UPDATE notifications SET status = 'digest', reason = 'muted', not_before = NULL,
         os_state = CASE WHEN os_state = 'queued' THEN 'cancelled' ELSE os_state END
        WHERE id = ? AND status IN ('sent', 'deferred') AND kind = 'insight'`,
      [id],
    ).changes === 1;
  if (done) touch(db);
  return done;
}

/** The user's "remind me later": a feed line waits until `notBefore` (P02-R11). */
export function deferNotification(db: SqlDriver, id: number, notBefore: string): boolean {
  const done =
    db.run(
      `UPDATE notifications SET status = 'deferred', not_before = ?,
         os_state = CASE WHEN os_state = 'queued' THEN 'cancelled' ELSE os_state END
        WHERE id = ? AND status = 'sent' AND kind = 'insight'`,
      [notBefore, id],
    ).changes === 1;
  if (done) touch(db);
  return done;
}

/**
 * The user read a line of the feed or of a digest (P02-R11). Its waiting OS message is cancelled by the outbox's
 * next settle, whatever the line's kind.
 */
export function markNotificationRead(db: SqlDriver, id: number, at: string): boolean {
  const done =
    db.run(
      `UPDATE notifications SET read_at = ?
        WHERE id = ? AND status IN ('sent', 'digest') AND read_at IS NULL`,
      [at, id],
    ).changes === 1;
  if (done) touch(db);
  return done;
}

/** The user closed a line (P02-R11): it leaves the feed and stays in the timeline; a waiting OS message is cancelled at the next settle. */
export function dismissNotification(db: SqlDriver, id: number, at: string): boolean {
  const done =
    db.run(
      `UPDATE notifications SET status = 'dismissed', not_before = NULL, read_at = coalesce(read_at, ?)
        WHERE id = ? AND status IN ('sent', 'digest', 'deferred')`,
      [at, id],
    ).changes === 1;
  if (done) touch(db);
  return done;
}

/** The lines whose OS message waits, oldest first. */
export const queuedNotifications = (db: SqlDriver): StoredNotification[] =>
  db.all("SELECT * FROM notifications WHERE os_state = 'queued' ORDER BY id").map(fromRow);

/** Sets the OS channel state of lines that are in `from`; returns how many changed. */
export function setOsState(
  db: SqlDriver,
  ids: readonly number[],
  from: OsState,
  to: OsState,
): number {
  let changed = 0;
  for (const id of ids) {
    changed += db.run("UPDATE notifications SET os_state = ? WHERE id = ? AND os_state = ?", [
      to,
      id,
      from,
    ]).changes;
  }
  if (changed > 0) touch(db);
  return changed;
}

/** The plain settings the OS channel reads (P02-R6, R10, D10); T2's API writes the same keys. */
export interface NotifySettings {
  os: boolean;
  quietHours: { enabled: boolean; start: string; end: string };
  snoozeUntil: string | null;
}

export const NOTIFY_SETTING_KEYS = {
  os: "notifications.os",
  quietHours: "notifications.quietHours",
  snoozeUntil: "notifications.snoozeUntil",
} as const;

export const DEFAULT_QUIET_HOURS = { enabled: true, start: "22:00", end: "08:00" } as const;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The settings with the defaults for a missing or malformed value: OS on, quiet 22:00-08:00, no snooze. */
export function readNotifySettings(db: SqlDriver): NotifySettings {
  let quiet: NotifySettings["quietHours"] = { ...DEFAULT_QUIET_HOURS };
  try {
    const raw = JSON.parse(readSetting(db, NOTIFY_SETTING_KEYS.quietHours) ?? "null") as {
      enabled?: unknown;
      start?: unknown;
      end?: unknown;
    } | null;
    if (
      raw &&
      typeof raw.enabled === "boolean" &&
      typeof raw.start === "string" &&
      typeof raw.end === "string" &&
      CLOCK.test(raw.start) &&
      CLOCK.test(raw.end)
    ) {
      quiet = { enabled: raw.enabled, start: raw.start, end: raw.end };
    }
  } catch {
    // a value that is not JSON is the default
  }
  const snooze = readSetting(db, NOTIFY_SETTING_KEYS.snoozeUntil);
  return {
    os: readSetting(db, NOTIFY_SETTING_KEYS.os) !== "off",
    quietHours: quiet,
    snoozeUntil: snooze !== undefined && !Number.isNaN(Date.parse(snooze)) ? snooze : null,
  };
}
