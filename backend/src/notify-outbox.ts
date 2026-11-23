// The OS channel of the notifications (P02-R6, R8, R9, R10): the backend's side of the toast. `flush` takes the
// lines whose OS message waits (`queued`), settles the ones that must not go (closed, read, no longer holding or muted by
// the user, P02-R7), keeps the rest in quiet hours and under a snooze, and otherwise writes `handed` for them in a committed
// transaction and only then posts one message to the shell. That order is the whole of "at most once": a process
// cut between the two leaves the lines `handed` and never repeats the message (P02-D9). The message holds a kind
// and two counts, never a name or a sentence; the shell owns the words (P02-R9). The shell's answer is recorded by
// `acknowledge`. Without a shell, or with the setting off, the lines end `unavailable` and the feed is untouched.
import { deliveryVerdict, lineShown } from "@pki/knowledge-engine";
import {
  demoteNotificationToDigest,
  listNotifications,
  queuedNotifications,
  readNotifySettings,
  setOsState,
  withdrawNotification,
  type DerivativeRegistry,
  type NotifySettings,
  type SqlDriver,
  type StoredNotification,
} from "@pki/storage";
import { systemTimeZone } from "./clock.ts";

/** The one message the backend posts to the shell for a toast; exactly these keys. */
export interface NotifyMessage {
  type: "notify";
  id: string;
  kind: "insight" | "daily" | "weekly";
  count: number;
  unread: number;
}

/** What the shell answers for a message it was given. */
export interface NotifyAck {
  type: "notify-ack";
  id: string;
  result: "shown" | "unavailable" | "failed";
}

/** The shell's side as the backend sees it; none when the backend runs without a shell. */
export interface NotifyChannel {
  send(message: NotifyMessage): void;
}

export interface NotifyOutboxDeps {
  db: SqlDriver;
  registry: Pick<DerivativeRegistry, "visible">;
  channel: NotifyChannel | null;
  now?: () => Date;
  /** The zone quiet hours are read in; default the runtime's. */
  zone?: () => string;
}

export interface NotifyOutbox {
  /** Hands the waiting lines to the shell as messages; how many messages went. */
  flush(): number;
  /** Records the shell's answer; true when `data` is such an answer (whether or not a line was waiting). */
  acknowledge(data: unknown): boolean;
}

const RESULTS = ["shown", "unavailable", "failed"] as const;

/** The shell's answer, exactly its three keys; anything else is undefined. */
function parseAck(data: unknown): NotifyAck | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (Object.keys(data).sort().join(",") !== "id,result,type") return undefined;
  const { type, id, result } = data as Record<string, unknown>;
  if (type !== "notify-ack" || typeof id !== "string" || id.length > 64) return undefined;
  return (RESULTS as readonly unknown[]).includes(result)
    ? { type, id, result: result as NotifyAck["result"] }
    : undefined;
}

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Minutes since local midnight in `zone`. */
function localMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return part("hour") * 60 + part("minute");
}

/** Whether the OS channel is held now: inside the quiet hours, or before the snooze's time. */
function held(settings: NotifySettings, at: Date, zone: string): boolean {
  if (settings.snoozeUntil !== null && at.getTime() < Date.parse(settings.snoozeUntil)) return true;
  const { enabled, start, end } = settings.quietHours;
  if (!enabled || start === end) return false;
  const [s, e, m] = [minutesOf(start), minutesOf(end), localMinutes(at, zone)];
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** The feed lines still unread that hold now: the number the tray and the screens show. */
export function unreadCount(db: SqlDriver, registry: Pick<DerivativeRegistry, "visible">): number {
  return listNotifications(db).filter(
    (n) =>
      n.kind === "insight" &&
      n.status === "sent" &&
      n.readAt === null &&
      lineShown(db, registry, {
        insightId: n.insightId as number,
        insightChangedAt: n.insightChangedAt,
      }),
  ).length;
}

export function createNotifyOutbox(deps: NotifyOutboxDeps): NotifyOutbox {
  const { db, registry, channel } = deps;
  const now = deps.now ?? (() => new Date());
  const zone = deps.zone ?? systemTimeZone;
  /** Message id -> the lines it carries, for the answer. Lost with the process: those lines stay `handed`. */
  const pending = new Map<string, number[]>();
  let serial = 0;

  /** Lines that no longer need their message: closed or read, or whose Insight no longer holds (R7). */
  function settle(): StoredNotification[] {
    return db.transaction(() => {
      const waiting: StoredNotification[] = [];
      for (const line of queuedNotifications(db)) {
        // a line the user read or closed, whatever its kind, needs no message
        if (line.status !== "sent" || line.readAt !== null) {
          setOsState(db, [line.id], "queued", "cancelled");
          continue;
        }
        if (line.kind === "insight") {
          const verdict = deliveryVerdict(db, registry, {
            insightId: line.insightId as number,
            insightChangedAt: line.insightChangedAt,
          });
          if (verdict !== "ok") {
            // a muted Insight stays in the digest; any other refusal leaves the feed (R7, P03)
            if (verdict === "digest") demoteNotificationToDigest(db, line.id);
            else withdrawNotification(db, line.id);
            continue;
          }
        }
        waiting.push(line);
      }
      return waiting;
    });
  }

  /** The lines a digest message counts: its window's, those that hold now. */
  const digestCount = (line: StoredNotification): number =>
    listNotifications(db).filter(
      (n) =>
        n.kind === "insight" &&
        n.status !== "withdrawn" &&
        n.createdAt >= (line.windowStart as string) &&
        n.createdAt < (line.windowEnd as string) &&
        lineShown(db, registry, {
          insightId: n.insightId as number,
          insightChangedAt: n.insightChangedAt,
        }),
    ).length;

  function flush(): number {
    const waiting = settle();
    if (waiting.length === 0) return 0;
    const settings = readNotifySettings(db);
    if (!settings.os || channel === null) {
      setOsState(
        db,
        waiting.map((l) => l.id),
        "queued",
        "unavailable",
      );
      return 0;
    }
    const at = now();
    if (held(settings, at, zone())) return 0;
    const unread = unreadCount(db, registry);
    const batches: { kind: NotifyMessage["kind"]; count: number; ids: number[] }[] = [];
    const insightIds = waiting.filter((l) => l.kind === "insight").map((l) => l.id);
    if (insightIds.length > 0)
      batches.push({ kind: "insight", count: insightIds.length, ids: insightIds });
    for (const line of waiting.filter((l) => l.kind !== "insight")) {
      const count = digestCount(line);
      if (count === 0) setOsState(db, [line.id], "queued", "cancelled");
      else batches.push({ kind: line.kind, count, ids: [line.id] });
    }
    const messages = batches.map((b) => ({
      message: {
        type: "notify",
        id: `${at.getTime().toString(36)}-${++serial}`,
        kind: b.kind,
        count: b.count,
        unread,
      } satisfies NotifyMessage,
      ids: b.ids,
    }));
    // `handed` is committed before any message is posted (R8)
    db.transaction(() => {
      for (const { ids } of messages) setOsState(db, ids, "queued", "handed");
    });
    for (const { message, ids } of messages) {
      pending.set(message.id, ids);
      try {
        channel.send(message);
      } catch {
        // the lines stay handed: a message that may or may not have gone is never sent again
      }
    }
    return messages.length;
  }

  return {
    flush,
    acknowledge(data) {
      const ack = parseAck(data);
      if (!ack) return false;
      const ids = pending.get(ack.id);
      if (ids) {
        pending.delete(ack.id);
        setOsState(db, ids, "handed", ack.result);
      }
      return true;
    },
  };
}
