// Words for a connection test result (V01-R21), in one place. A reason the screen
// does not know is shown as its code: it is always a code, never Provider text.
import type { ConnectionTestResult } from "@pki/contracts";

const REASON: Readonly<Record<string, string>> = {
  "no-provider": "기본 Provider가 정해지지 않음",
  "no-consent": "외부 전송 동의 없음",
  "consent-stale-destination": "동의가 무효(목적지가 바뀜)",
  "consent-stale-policy": "동의가 무효(전송 정책이 바뀜)",
  "destination-unavailable": "목적지가 설정되지 않음",
  "insecure-endpoint": "https가 아닌 주소",
  "rule-denied": "전송 규칙이 거부함",
  "no-matching-rule": "맞는 전송 규칙이 없음",
  "cli-not-verified": "격리가 검증된 CLI 조합(버전·OS·인자 프로필)이 아님",
  "cli-unknown": "인자 프로필이 없는 CLI",
  "cli-background-off": "백그라운드 실행이 꺼져 있음",
  "unverified-ack-required": "격리 미검증 경고를 확인하지 않음",
  "unverified-background": "격리 미검증 CLI는 백그라운드로 실행하지 않음",
  "unverified-not-synthetic": "격리 미검증 CLI에는 합성 자료만 보냄",
  "unverified-malicious": "격리 미검증 CLI에는 악성 변형 자료를 보내지 않음",
  "budget-exhausted": "호출 예산 소진",
  "structured-output-unsupported": "구조화 출력을 지원하지 않는 Provider",
  "capabilities-unavailable": "Provider 기능을 읽을 수 없음",
};

/** A block reason in words; an unknown code is shown as it is (it is never Provider text). */
export function blockReasonText(reason: string): string {
  return REASON[reason] ?? reason;
}

const ERROR: Readonly<Record<string, string>> = {
  timeout: "시간 초과",
  "rate-limited": "요청 한도",
  "provider-error": "Provider 오류",
  "invalid-output": "응답 형식이 맞지 않음",
};

const ISOLATION = { verified: "(격리 검증된 CLI 조합)", unverified: "(격리 미검증)" } as const;

export function connectionTestText(result: ConnectionTestResult): string {
  const reason = result.reason ?? "";
  switch (result.outcome) {
    case "ok":
      return `성공${result.isolation ? ISOLATION[result.isolation] : ""}`;
    case "blocked":
      return `차단: ${blockReasonText(reason)}`;
    case "failed":
      return `오류: ${ERROR[reason] ?? reason}`;
    case "rejected":
      return `거부: ${reason}`;
  }
}

/** The development build runs an unverified CLI only after the user confirms this one call. */
export function needsUnverifiedConfirmation(result: ConnectionTestResult): boolean {
  return result.outcome === "blocked" && result.reason === "unverified-ack-required";
}
