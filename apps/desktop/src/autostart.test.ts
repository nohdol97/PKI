// H02A-C6: the tray's autostart item (spec 2026-11-24-H02-common, R10).
import { describe, expect, it, vi } from "vitest";
import { autostartMenuItem } from "./autostart.ts";

describe("autostartMenuItem", () => {
  it("H02A-C6: packaged: shows the OS state and a click sets the opposite once", () => {
    const set = vi.fn();
    const item = autostartMenuItem({ packaged: true, get: () => false, set });
    expect(item).toMatchObject({ type: "checkbox", checked: false, enabled: true });
    item.click();
    expect(set).toHaveBeenCalledExactlyOnceWith(true);
    const on = vi.fn();
    autostartMenuItem({ packaged: true, get: () => true, set: on }).click();
    expect(on).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("H02A-C6: not packaged: the item is disabled and set is never called", () => {
    const set = vi.fn();
    const item = autostartMenuItem({ packaged: false, get: () => false, set });
    expect(item.enabled).toBe(false);
    item.click();
    expect(set).not.toHaveBeenCalled();
  });
});
