// UIF-C2 (R2): the backup folder pick against a fake picker. A pick the shell could not hand to the backend answers
// with the neutral text and never chooses; a ticket is chosen once; a cancel does nothing.
import { describe, expect, it, vi } from "vitest";
import { pickBackupFolder } from "./backup.tsx";
import { PICK_BACKEND_UNAVAILABLE_TEXT } from "./local-locations-text.ts";

describe("백업 폴더 고르기 (UIF-C2)", () => {
  it("returns the text and does not choose when the backend was unavailable", async () => {
    const choose = vi.fn(async () => undefined);
    const text = await pickBackupFolder(
      async () => ({ ticket: null, failed: "backend-unavailable" }),
      choose,
    );
    expect(text).toBe(PICK_BACKEND_UNAVAILABLE_TEXT);
    expect(choose).not.toHaveBeenCalled();
  });

  it("chooses the ticket once and returns nothing", async () => {
    const choose = vi.fn(async () => undefined);
    const text = await pickBackupFolder(async () => ({ ticket: "t" }), choose);
    expect(text).toBeUndefined();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith({ ticket: "t" });
  });
});
