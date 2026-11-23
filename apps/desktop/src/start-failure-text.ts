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
  "ledger-unavailable":
    "삭제 장부 파일을 열거나 만들지 못해 시작하지 않았습니다. 데이터는 그대로 두었습니다. 삭제를 장부에 적을 수 없으면 삭제가 복원 뒤 되살아날 수 있어 막았습니다. 디스크의 빈 공간과 데이터 폴더의 쓰기 권한을 확인한 뒤 다시 시작하세요.",
  "site-registration-invalid":
    "이 빌드의 등록이 공용 수집기 종류나 공용 인스턴스를 건드려 시작하지 않았습니다. 공용이 지키는 승인 절차나 합성 등급을 건너뛰지 못하게 막았습니다. 어느 것이 몇 건인지는 표준 오류의 한 줄에 코드와 건수로 남아 있습니다. 등록 검사 테스트가 알려 주는 코드를 고쳐 다시 빌드하세요.",
  "adapter-unregistered":
    "이 빌드에 묶인 엔진이나 벡터 구현이 삭제 규칙에 등록되어 있지 않아 시작하지 않았습니다. 지운 자료가 그 구현에 남을 수 있어 막았습니다. 구현을 등록한 빌드로 다시 시작하세요.",
  "restore-marker-unreadable":
    "복원이 어디까지 갔는지 적은 표식 파일(restore 폴더 안)을 읽을 수 없어 시작하지 않았습니다. 데이터는 그대로 두었습니다. 앱을 끈 채 데이터 폴더를 먼저 복사해 두세요. pki.sqlite.before-restore 파일이 없으면 restore 폴더만 폴더 밖으로 옮기면 지금 데이터로 시작합니다(복원은 다시 요청). 그 파일이 있으면 pki.sqlite를 밖으로 옮기고 사본의 이름을 pki.sqlite로 바꾼 뒤 restore 폴더를 밖으로 옮기세요. 파일은 삭제하지 말고 옮기기만 하세요.",
  "restore-before-orphaned":
    "복원 표식 없이 이전 데이터 사본(pki.sqlite.before-restore)만 남아 있어 시작하지 않았습니다. 데이터는 그대로 두었습니다. 앱을 끈 채 데이터 폴더를 먼저 복사해 두세요. pki.sqlite가 없으면 사본의 이름을 pki.sqlite로 바꿔 시작하세요. pki.sqlite가 있으면 어느 쪽이 맞는지 앱이 알 수 없습니다. 지금 것을 쓰려면 사본만 폴더 밖으로 옮기고, 이전 것을 쓰려면 pki.sqlite를 밖으로 옮긴 뒤 사본의 이름을 pki.sqlite로 바꾸세요. 파일은 삭제하지 말고 옮기기만 하세요.",
  "restore-live-missing":
    "복원 중 데이터 파일(pki.sqlite) 자리가 비어 있어 시작하지 않았습니다. 데이터는 그대로 두었습니다. 앱을 끈 채 데이터 폴더를 먼저 복사해 두세요. pki.sqlite.before-restore가 있으면 그 이름을 pki.sqlite로 바꾸고 restore 폴더를 밖으로 옮긴 뒤 시작하세요. 없으면 restore 폴더를 밖으로 옮겨 시작하고 백업 파일에서 다시 복원하세요. 파일은 삭제하지 말고 옮기기만 하세요.",
  "restore-state-inconsistent":
    "복원 준비 파일, 이전 데이터 사본(pki.sqlite.before-restore), 데이터 파일(pki.sqlite)이 모두 있어 어느 상태인지 알 수 없습니다. 앱을 끈 채 데이터 폴더를 먼저 복사해 두세요. 지금 것을 쓰려면 사본과 restore 폴더를 폴더 밖으로 옮기고, 이전 것을 쓰려면 pki.sqlite를 밖으로 옮긴 뒤 사본의 이름을 pki.sqlite로 바꾸고 restore 폴더를 옮기세요. 파일은 삭제하지 말고 옮기기만 하세요.",
  "restore-previous-unverified":
    "이전 데이터 사본(pki.sqlite.before-restore)이 데이터베이스 파일이 아니라 되돌릴 수 없어 시작하지 않았습니다. pki.sqlite는 마무리되지 않은 복원본이라 그대로 쓰지 마세요. 앱을 끈 채 데이터 폴더를 먼저 복사해 두세요. pki.sqlite, pki.sqlite.before-restore, restore 폴더를 모두 폴더 밖으로 옮기고 시작한 뒤 백업 파일에서 다시 복원하세요. 파일은 삭제하지 말고 옮기기만 하세요.",
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
