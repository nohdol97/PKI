// I04-R7 (identity.key, T07 handoff via I04-T13): a start refused for the missing
// identity key shows its reason; the backend reports the class only, never a message.
import { describe, expect, it } from "vitest";
import { startBackendProcess, type BackendChild } from "./backend-process.ts";
import { startFailureText } from "./start-failure-text.ts";

function childReporting(report: unknown): BackendChild {
  let onMessage: (message: unknown) => void = () => undefined;
  return {
    pid: 1,
    postMessage: () => queueMicrotask(() => onMessage(report)),
    on: (_event, listener) => void (onMessage = listener),
    once: () => undefined,
    kill: () => true,
  };
}
const start = (report: unknown) =>
  startBackendProcess({
    fork: () => childReporting(report),
    entry: "unused",
    origin: "app://pki",
  });

describe("identity.key start failure text", () => {
  it("carries the reported class from the backend to the failure text", async () => {
    const error = await start({ type: "failed", reason: "identity-key-missing" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("backend failed to start");
    expect(startFailureText(error)).toContain("식별자 키");
    expect(startFailureText(error)).toContain("가져오기와 동기화를 열지 않");
  });

  it("keeps the generic text for a failure with no known reason", async () => {
    const bare = await start({ type: "failed" }).catch((e: unknown) => e);
    expect(startFailureText(bare)).toBe("앱을 시작하지 못했습니다.");
    expect(startFailureText("anything")).toBe("앱을 시작하지 못했습니다.");
  });

  it("refuses a reason outside the known classes", async () => {
    const error = await start({ type: "failed", reason: "ENOENT /secret/path" }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe("backend sent an unexpected message");
    expect(startFailureText(error)).toBe("앱을 시작하지 못했습니다.");
  });
});
