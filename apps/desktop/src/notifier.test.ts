// P02-C2b (R9, R12): the shell's notification module over a fake Electron `Notification` and tray. A valid
// message shows one toast whose words are the shell's fixed ones with the count, and sets the tray's tooltip to the
// unread count; a message with one key more is dropped whole (no toast, no tooltip, no answer); a platform that
// cannot show a notification is answered `unavailable` without a throw. No real OS notification is shown.
import { describe, expect, it } from "vitest";
import { createNotifier } from "./notifier.ts";

type Toast = { title: string; body: string; silent: boolean };

/** A fake `Notification`: records what was made and, on `show()`, fires the events `events` names. */
function fakes(
  options: { supported?: boolean; events?: ("show" | "failed")[]; throws?: boolean } = {},
) {
  const made: Toast[] = [];
  const shown: number[] = [];
  const tooltips: string[] = [];
  let focused = 0;
  let click: (() => void) | undefined;
  const notification = {
    isSupported: () => options.supported ?? true,
    create(toast: Toast) {
      if (options.throws) throw new Error("no notification service");
      made.push(toast);
      const handlers = new Map<string, () => void>();
      return {
        show() {
          shown.push(made.length);
          for (const event of options.events ?? ["show"]) handlers.get(event)?.();
        },
        on(event: "show" | "failed" | "click", listener: () => void) {
          handlers.set(event, listener);
          if (event === "click") click = listener;
        },
      };
    },
  };
  const tray = { setToolTip: (text: string) => void tooltips.push(text) };
  return {
    made,
    shown,
    tooltips,
    focused: () => focused,
    clickToast: () => click?.(),
    notifier: createNotifier({
      notification,
      tray,
      focusWindow: () => void (focused += 1),
      waitMs: 5,
    }),
  };
}

const message = { type: "notify", id: "a-1", kind: "insight", count: 3, unread: 5 };

describe("notifier", () => {
  it("① shows one toast with the fixed words and the count, sets the tray tooltip to the unread count, and a click brings the window up", async () => {
    const f = fakes();
    expect(await f.notifier.show(message)).toBe("shown");
    expect(f.made).toEqual([{ title: "PKI", body: "확인할 변경이 3건 있습니다", silent: false }]);
    expect(f.shown).toHaveLength(1);
    expect(f.tooltips).toEqual(["PKI · 읽지 않은 알림 5건"]);
    f.clickToast();
    expect(f.focused()).toBe(1);

    expect(
      await f.notifier.show({ ...message, id: "a-2", kind: "weekly", count: 7, unread: 0 }),
    ).toBe("shown");
    expect(f.made[1]?.body).toBe("주간 지식 리포트에 확인할 변경이 7건 있습니다");
    expect(f.tooltips[1]).toBe("PKI");
  });

  it("② drops a message with one key more, a wrong type or a kind it does not know: no toast, no tooltip, no answer", async () => {
    const f = fakes();
    for (const bad of [
      { ...message, summary: "항목 이름" },
      { ...message, count: "3" },
      { ...message, kind: "mail" },
      { ...message, count: -1 },
      { type: "notify", id: "a-1", kind: "insight", count: 3 },
      null,
    ]) {
      expect(await f.notifier.show(bad)).toBeUndefined();
    }
    expect(f.made).toEqual([]);
    expect(f.tooltips).toEqual([]);
  });

  it("③ answers unavailable when the platform cannot show a notification, failed when it throws, and nothing when it never reports", async () => {
    expect(await fakes({ supported: false }).notifier.show(message)).toBe("unavailable");
    expect(await fakes({ throws: true }).notifier.show(message)).toBe("failed");
    expect(await fakes({ events: ["failed"] }).notifier.show(message)).toBe("failed");
    // permission denied on some platforms reports neither: the line stays handed, the feed is untouched
    expect(await fakes({ events: [] }).notifier.show(message)).toBeUndefined();
  });
});
