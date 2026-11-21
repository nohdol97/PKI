// V01-R21: the Settings screen states a connection test's result in words: success
// (with "격리 미검증" for an unverified CLI), the block reason, or the error.
import { describe, expect, it } from "vitest";
import { connectionTestText, needsUnverifiedConfirmation } from "./connection-test-text.ts";

describe("connectionTestText", () => {
  it.each([
    [{ outcome: "ok", reason: null, isolation: null }, "성공"],
    [{ outcome: "ok", reason: null, isolation: "verified" }, "성공(격리 검증된 CLI 조합)"],
    [{ outcome: "ok", reason: null, isolation: "unverified" }, "성공(격리 미검증)"],
    [
      { outcome: "blocked", reason: "no-provider", isolation: null },
      "차단: 기본 Provider가 정해지지 않음",
    ],
    [{ outcome: "blocked", reason: "no-consent", isolation: null }, "차단: 외부 전송 동의 없음"],
    [
      { outcome: "blocked", reason: "cli-not-verified", isolation: null },
      "차단: 격리가 검증된 CLI 조합(버전·OS·인자 프로필)이 아님",
    ],
    [{ outcome: "blocked", reason: "made-up-code", isolation: null }, "차단: made-up-code"],
    [{ outcome: "failed", reason: "timeout", isolation: null }, "오류: 시간 초과"],
    [{ outcome: "failed", reason: "provider-error", isolation: null }, "오류: Provider 오류"],
    [{ outcome: "rejected", reason: "invalid-request", isolation: null }, "거부: invalid-request"],
  ] as const)("%o → %s", (result, text) => {
    expect(connectionTestText(result)).toBe(text);
  });

  it("asks for the unverified-isolation confirmation only when the gate needs it", () => {
    expect(
      needsUnverifiedConfirmation({
        outcome: "blocked",
        reason: "unverified-ack-required",
        isolation: null,
      }),
    ).toBe(true);
    expect(
      needsUnverifiedConfirmation({
        outcome: "blocked",
        reason: "cli-not-verified",
        isolation: null,
      }),
    ).toBe(false);
    expect(
      needsUnverifiedConfirmation({ outcome: "ok", reason: null, isolation: "unverified" }),
    ).toBe(false);
  });
});
