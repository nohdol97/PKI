// The dialog's words for a start that failed (I04-R7). Only a reason the backend
// reported as a fixed class gets its own text; anything else is the generic one.
import { BackendStartError, type StartFailureReason } from "./backend-process.ts";

const GENERIC = "앱을 시작하지 못했습니다.";

const REASON_TEXT: Record<Exclude<StartFailureReason, "ledger-reapply-failed">, string> = {
  "identity-key-missing":
    "이 데이터의 식별자 키가 없어 시작하지 않았습니다. 지운 자료가 다시 들어오지 못하게 하는 표식을 읽을 수 없어 가져오기와 동기화를 열지 않습니다. 키를 복원한 뒤 다시 시작하세요.",
  "scope-policy-not-implemented":
    "배포처 후속: 접근 범위 정책 `site`는 이 공용 빌드에 구현되어 있지 않아 시작하지 않았습니다. 배포처 구현이 들어간 빌드를 설치하세요.",
  "scope-policy-invalid":
    "이 빌드의 접근 범위 정책 이름이 비어 있거나 알 수 없는 이름이라 시작하지 않았습니다. 빌드 설정을 고쳐 다시 빌드하세요.",
  "adapter-unregistered":
    "이 빌드에 묶인 엔진이나 벡터 구현이 삭제 규칙에 등록되어 있지 않아 시작하지 않았습니다. 지운 자료가 그 구현에 남을 수 있어 막았습니다. 구현을 등록한 빌드로 다시 시작하세요.",
};

/** The ledger line is a number the backend reports; no identifier or path is in the text. */
const ledgerText = (line: number | undefined) =>
  `삭제 장부의 ${line === undefined ? "한" : `${line}번`} 줄을 다시 적용하지 못해 시작하지 않았습니다. 삭제한 자료가 되살아나지 않도록 데이터를 열지 않습니다. 데이터 폴더와 안의 삭제 장부 파일을 그대로 두고(장부를 지우면 삭제가 풀립니다) 이 줄 번호를 알려 주세요. 원인이 고쳐지기 전에는 앱이 시작되지 않습니다.`;

export function startFailureText(error: unknown): string {
  if (!(error instanceof BackendStartError) || error.reason === undefined) return GENERIC;
  return error.reason === "ledger-reapply-failed"
    ? ledgerText(error.ledgerLine)
    : REASON_TEXT[error.reason];
}
