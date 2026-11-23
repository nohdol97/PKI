// The notification read path and the user's actions (P02-R7, R11, R14). A line is ids and codes; what leaves the
// backend is judged now: a line is shown only while its Insight is shown by the read gate (purpose `display`,
// with the user's `hidden` feedback) and still has the content the line was made for, and a digest row is shown
// only while its window holds at least one such line (or, for the weekly report, an open finding). The words of a
// line are the Insight's, built by the same view the Insight list uses. A digest's content is computed here, when
// asked, never stored. Nothing here writes a message to the shell or reads the network.
import {
  NOTIFICATION_SNOOZE_MINUTES,
  type NotificationLine,
  type RouteRequest,
  type RouteResponse,
} from "@pki/contracts";
import { deliveryVerdict } from "@pki/knowledge-engine";
import {
  demoteNotificationToDigest,
  deferNotification,
  dismissNotification,
  listFindings,
  listNotifications,
  markNotificationRead,
  NOTIFY_SETTING_KEYS,
  readChangeSeq,
  readKnowledgeRevision,
  readNotification,
  readNotifySeq,
  readNotifySettings,
  returnNotification,
  withdrawNotification,
  writeSetting,
  type ActiveInsight,
  type DerivativeRegistry,
  type SqlDriver,
  type StoredNotification,
} from "@pki/storage";
import type { FeedbackApi } from "./feedback-api.ts";
import { insightView } from "./insight-view.ts";
import type { LintReads } from "./lint-read.ts";
import { unreadCount } from "./notify-outbox.ts";
import type { ReadGate } from "./read-gate.ts";

type Line = NotificationLine;
type Settings = RouteResponse<"notificationSettings">;

/** Provisional: the lines and the digest rows one answer carries, newest first. */
const LINE_LIMIT = 300;
const DIGEST_LIMIT = 30;

type Shown = Exclude<StoredNotification["status"], "withdrawn">;

export interface NotifyRead {
  list(): RouteResponse<"notifications">;
  digest(id: number): RouteResponse<"notificationDigest">;
  act(request: RouteRequest<"notificationAct">, at: string): RouteResponse<"notificationAct">;
  /** The unread feed lines, by the same check the shell's tray count uses. */
  unread(): number;
  changes(): RouteResponse<"changes">;
  settings(): Settings;
  writeSettings(patch: RouteRequest<"setNotificationSettings">): Settings;
}

export function createNotifyRead(
  db: SqlDriver,
  registry: DerivativeRegistry,
  gate: ReadGate,
  feedback: FeedbackApi,
  lint: LintReads,
  clock: () => Date,
): NotifyRead {
  const actionsOf = (n: StoredNotification): Line["actions"] => {
    switch (n.status) {
      case "sent":
        return ["evidence", ...(n.readAt === null ? ["read" as const] : []), "snooze", "dismiss"];
      case "digest":
        return ["evidence", ...(n.readAt === null ? ["read" as const] : []), "dismiss"];
      case "deferred":
        return ["evidence", "unsnooze", "dismiss"];
      default:
        return ["evidence"];
    }
  };

  /** The line as shown, from its Insight as the gate shows it; undefined when the line is not shown. */
  const lineOf = (n: StoredNotification, insight: ActiveInsight | undefined): Line | undefined => {
    if (n.kind !== "insight" || n.status === "withdrawn" || insight === undefined) return undefined;
    if ((insight.changedAt ?? "") !== (n.insightChangedAt ?? "")) return undefined;
    return {
      id: n.id,
      status: n.status as Shown,
      reason: n.reason,
      notBefore: n.notBefore,
      createdAt: n.createdAt,
      readAt: n.readAt,
      actions: actionsOf(n),
      insight: insightView(insight, clock()),
    };
  };

  /** Every Insight line that is shown now, newest first: one read of the gate for the whole answer. */
  const shownLines = (): Line[] => {
    const insights = new Map(
      feedback.visibleInsights(gate.insights()).map((insight) => [insight.id, insight]),
    );
    return listNotifications(db)
      .filter((n) => n.kind === "insight")
      .flatMap((n) => lineOf(n, insights.get(n.insightId as number)) ?? [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  };

  /** The shown findings of the lint, read once: the counts and the ids the window's opened ones are picked from. */
  const lintOnce = () => {
    const read = lint.list();
    return { read, shown: new Set(read.findings.map((f) => f.id)) };
  };

  const windowLines = (lines: readonly Line[], n: StoredNotification) =>
    lines.filter(
      (l) => l.createdAt >= (n.windowStart as string) && l.createdAt < (n.windowEnd as string),
    );

  const openedIn = (shown: ReadonlySet<number>, n: StoredNotification) =>
    listFindings(db).filter(
      (f) =>
        shown.has(f.id) &&
        f.createdAt >= (n.windowStart as string) &&
        f.createdAt < (n.windowEnd as string),
    ).length;

  const digestContent = (
    n: StoredNotification,
    lines: readonly Line[],
    findings: ReturnType<typeof lintOnce>,
  ) => ({
    kind: n.kind as "daily" | "weekly",
    windowStart: n.windowStart as string,
    windowEnd: n.windowEnd as string,
    lines: windowLines(lines, n),
    lint:
      n.kind === "weekly"
        ? { counts: findings.read.counts, opened: openedIn(findings.shown, n) }
        : null,
  });

  /** A digest row is shown while its window holds a shown line or, for the weekly report, an open finding (reviewer FU4). */
  const digestShown = (
    n: StoredNotification,
    content: ReturnType<typeof digestContent>,
    findings: ReturnType<typeof lintOnce>,
  ) =>
    content.lines.length > 0 ||
    (n.kind === "weekly" && findings.read.counts.some((c) => c.open > 0));

  const digestRows = (lines: readonly Line[]) => {
    const findings = lintOnce();
    return listNotifications(db)
      .filter((n) => n.kind !== "insight" && n.status === "sent")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
      .flatMap((n) => {
        const content = digestContent(n, lines, findings);
        return digestShown(n, content, findings) ? [{ n, content, findings }] : [];
      });
  };

  const unread = () => unreadCount(db, registry);

  const readSettings = (): Settings => readNotifySettings(db);

  return {
    list() {
      const lines = shownLines();
      return {
        lines: lines.slice(0, LINE_LIMIT),
        digests: digestRows(lines)
          .slice(0, DIGEST_LIMIT)
          .map(({ n, content }) => ({
            id: n.id,
            kind: content.kind,
            windowStart: content.windowStart,
            windowEnd: content.windowEnd,
            createdAt: n.createdAt,
            readAt: n.readAt,
            count: content.lines.length,
          })),
        unread: lines.filter((l) => l.status === "sent" && l.readAt === null).length,
      };
    },

    digest(id) {
      const found = digestRows(shownLines()).find((row) => row.n.id === id);
      return { digest: found?.content ?? null };
    },

    act(request, at) {
      const answer = (status: "applied" | "refused" | "not-found") => ({
        status,
        unread: unread(),
      });
      return db.transaction(() => {
        const n = readNotification(db, request.id);
        if (!n || n.status === "withdrawn") return answer("not-found");
        if (n.kind === "insight") {
          // the same judgement as the list, for this one line
          const insight = gate.insightEvidence(n.insightId as number)?.insight;
          const shown = insight && feedback.visibleInsights([insight]).length === 1;
          if (!shown || lineOf(n, insight) === undefined) return answer("not-found");
        } else if (!digestRows(shownLines()).some((row) => row.n.id === n.id)) {
          return answer("not-found");
        }
        switch (request.op) {
          case "read":
            return answer(markNotificationRead(db, n.id, at) ? "applied" : "refused");
          case "dismiss":
            return answer(dismissNotification(db, n.id, at) ? "applied" : "refused");
          case "snooze": {
            if (
              request.minutes === undefined ||
              !(NOTIFICATION_SNOOZE_MINUTES as readonly number[]).includes(request.minutes)
            ) {
              return answer("refused");
            }
            const until = new Date(Date.parse(at) + request.minutes * 60_000).toISOString();
            return answer(deferNotification(db, n.id, until) ? "applied" : "refused");
          }
          case "unsnooze": {
            if (n.kind !== "insight" || n.status !== "deferred") return answer("refused");
            // the line passes the same check as a deferred line whose time has come (P02-R7)
            const verdict = deliveryVerdict(db, registry, {
              insightId: n.insightId as number,
              insightChangedAt: n.insightChangedAt,
            });
            if (verdict === "ok")
              return answer(returnNotification(db, n.id, false) ? "applied" : "refused");
            if (verdict === "digest") {
              return answer(demoteNotificationToDigest(db, n.id) ? "applied" : "refused");
            }
            withdrawNotification(db, n.id);
            return answer("not-found");
          }
        }
      });
    },

    unread,

    changes: () => ({
      sources: readChangeSeq(db),
      knowledge: readKnowledgeRevision(db),
      notifications: readNotifySeq(db),
      unread: unread(),
    }),

    settings: readSettings,

    writeSettings(patch) {
      if (patch.os !== undefined) writeSetting(db, NOTIFY_SETTING_KEYS.os, patch.os ? "on" : "off");
      if (patch.quietHours !== undefined) {
        writeSetting(db, NOTIFY_SETTING_KEYS.quietHours, JSON.stringify(patch.quietHours));
      }
      if (patch.snoozeUntil !== undefined) {
        writeSetting(
          db,
          NOTIFY_SETTING_KEYS.snoozeUntil,
          patch.snoozeUntil === null ? "" : new Date(patch.snoozeUntil).toISOString(),
        );
      }
      return readSettings();
    },
  };
}
