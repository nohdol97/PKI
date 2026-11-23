// The shell's side of the OS notification (P02-R9, R12, D8, D13). The backend posts one message,
// `{ type: "notify", id, kind, count, unread }`, and nothing else: this module checks it key for key and value for
// value, and owns the only words an OS toast or the tray ever shows (a fixed template per kind with the count put
// in). No name, sentence or source title can cross to the OS, because none is in the message. The Electron objects
// are injected (`Notification`, the tray), so a test shows no real notification. A toast brings the window up when
// clicked and goes nowhere else (no deep link, D13).
import { z } from "zod";

/** The message exactly: `strictObject` drops one with a key more (a name, a sentence) whole. */
export const NotifyMessageSchema = z.strictObject({
  type: z.literal("notify"),
  id: z.string().min(1).max(64),
  kind: z.enum(["insight", "daily", "weekly"]),
  count: z.int().min(0).max(100_000),
  unread: z.int().min(0).max(100_000),
});
export type NotifyMessage = z.infer<typeof NotifyMessageSchema>;

export type NotifyResult = "shown" | "unavailable" | "failed";

/** The fixed words: a template per kind, the count the only thing put in. */
const BODY: Record<NotifyMessage["kind"], (count: number) => string> = {
  insight: (n) => `확인할 변경이 ${n}건 있습니다`,
  daily: (n) => `오늘의 요약에 확인할 변경이 ${n}건 있습니다`,
  weekly: (n) => `주간 지식 리포트에 확인할 변경이 ${n}건 있습니다`,
};
const TITLE = "PKI";
const trayText = (unread: number) => (unread > 0 ? `${TITLE} · 읽지 않은 알림 ${unread}건` : TITLE);

/** The part of Electron's `Notification` instance this module uses. */
export interface ToastLike {
  show(): void;
  on(event: "show" | "failed" | "click", listener: () => void): unknown;
}
export interface NotifierDeps {
  notification: {
    isSupported(): boolean;
    create(options: { title: string; body: string; silent: boolean }): ToastLike;
  };
  /** The tray icon's tooltip; none when no tray could be made. */
  tray?: { setToolTip(text: string): void } | undefined;
  /** Brings the main window to the front (a click on a toast). */
  focusWindow(): void;
  /** How long to wait for the platform to report `show` or `failed` (default 3 s). */
  waitMs?: number;
}

export function createNotifier(deps: NotifierDeps) {
  return {
    /**
     * Shows the toast of a valid message and answers what the platform did; undefined when the message is not
     * exactly the five keys (nothing is shown, nothing answered) or when the platform reported neither `show` nor
     * `failed` in time (the backend leaves that line `handed`; the feed is untouched).
     */
    async show(raw: unknown): Promise<NotifyResult | undefined> {
      const parsed = NotifyMessageSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      const { kind, count, unread } = parsed.data;
      deps.tray?.setToolTip(trayText(unread));
      if (!deps.notification.isSupported()) return "unavailable";
      try {
        const toast = deps.notification.create({
          title: TITLE,
          body: BODY[kind](count),
          silent: false,
        });
        toast.on("click", deps.focusWindow);
        const reported = new Promise<NotifyResult | undefined>((resolve) => {
          toast.on("show", () => resolve("shown"));
          toast.on("failed", () => resolve("failed"));
          setTimeout(() => resolve(undefined), deps.waitMs ?? 3_000).unref?.();
        });
        toast.show();
        return await reported;
      } catch {
        return "failed";
      }
    },
  };
}
