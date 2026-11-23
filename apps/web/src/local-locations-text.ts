// The Settings screen's "로컬 자료" texts (I02B-R38): why an approval was refused, what a location's state
// is, and the two fixed marks of this release. One text per code; the key set is the contract's list
// (`APPROVAL_REJECTION_TEXT` is total by type, local-locations-text.test.ts pins the runtime keys).
import type {
  LocalApprovalRejectionCode,
  LocalLocationInfo,
  LocalSkipReason,
} from "@pki/contracts";

export const APPROVAL_REJECTION_TEXT: Record<LocalApprovalRejectionCode, string> = {
  "not-absolute":
    "전체 경로(맨 앞이 폴더 이름이 아니라 드라이브나 / 로 시작하는 경로)를 적어야 합니다.",
  "unsupported-path-form": "이 경로 모양은 지원하지 않습니다. 평범한 폴더 경로를 골라 주세요.",
  "not-found": "그 폴더를 찾을 수 없습니다.",
  "not-readable": "그 폴더를 읽을 수 없습니다. 읽기 권한을 확인해 주세요.",
  "location-unreachable":
    "이미 추가한 위치 가운데 지금 열 수 없는 곳이 있어(예: 뽑아 둔 디스크) 겹치는지 확인할 수 없습니다. 그 디스크를 다시 연결한 뒤 다시 시도해 주세요.",
  "wrong-type": "폴더가 아닙니다. 폴더를 골라 주세요.",
  "identity-unavailable": "이 폴더를 안정적으로 알아볼 수 없어 추가하지 않았습니다.",
  "filesystem-root": "디스크 전체는 추가할 수 없습니다. 그 안의 폴더를 골라 주세요.",
  "inside-data-directory": "이 앱의 데이터 폴더 안은 추가할 수 없습니다.",
  "overlaps-location": "이미 추가한 위치와 겹칩니다.",
  "network-location": "네트워크 위치는 추가할 수 없습니다.",
  "unsupported-format": "이 형식은 지원하지 않습니다.",
  "ticket-required": "폴더 선택 창에서 고른 폴더만 추가할 수 있습니다. 다시 선택해 주세요.",
};

export const LOCATION_STATE_TEXT: Record<LocalLocationInfo["state"], string> = {
  active: "읽는 중",
  paused: "일시 중지",
  unavailable: "찾을 수 없음",
  "needs-confirmation": "삭제 확인 필요",
  revoking: "철회하는 중",
};

export const NORMALIZER_UNAVAILABLE_TEXT = "문서를 읽는 프로그램이 뜨지 않아 멈춤";
export const NOT_WATCHING_TEXT = "실시간 감시 없음";

/** One text per skip reason (I02B-R16, R38); the key set is the contract's list, a test pins the runtime keys. */
export const SKIP_REASON_TEXT: Record<LocalSkipReason, string> = {
  "unsupported-format": "지원하지 않는 형식입니다.",
  "format-mismatch": "확장자와 실제 내용의 형식이 다릅니다.",
  "outside-root": "승인한 폴더 밖을 가리켜 읽지 않았습니다.",
  "not-a-file": "파일이 아닙니다.",
  "read-failed": "파일을 읽지 못했습니다.",
  "too-large": "파일이 너무 커서 읽지 않았습니다.",
  "zip-limit": "압축 안의 내용이 한도를 넘어 읽지 않았습니다.",
  "zip-path": "압축 안의 경로가 안전하지 않아 읽지 않았습니다.",
  "encoding-undecidable": "글자 인코딩을 알아낼 수 없습니다.",
  encrypted: "암호가 걸려 있어 읽을 수 없습니다.",
  corrupt: "파일이 깨져 있어 읽을 수 없습니다.",
  "timed-out": "읽는 데 시간이 너무 오래 걸려 멈췄습니다.",
  "resource-exceeded": "읽는 데 메모리가 너무 많이 들어 멈췄습니다.",
  "worker-failed": "문서를 읽는 프로그램이 이 파일에서 실패했습니다. 다음 훑기에 다시 시도합니다.",
  symlink: "바로가기(심볼릭 링크)는 따라가지 않습니다.",
  redirected: "경로가 다른 곳으로 바뀌어 읽지 않았습니다. 다음 훑기에 다시 시도합니다.",
  "not-regular-file": "일반 파일이 아니라 읽지 않았습니다.",
  "path-too-long": "경로가 너무 길어 읽지 않았습니다.",
  "too-deep": "폴더가 너무 깊어 읽지 않았습니다.",
  "identity-unavailable": "이 파일을 안정적으로 알아볼 수 없어 읽지 않았습니다.",
  locked: "다른 프로그램이 쓰고 있어 읽지 못했습니다. 다음 훑기에 다시 시도합니다.",
  "not-readable": "읽기 권한이 없습니다. 다음 훑기에 다시 시도합니다.",
  "user-deleted": "사용자가 제품에서 지운 파일입니다. 지운 원본의 삭제를 해제해야 다시 가져옵니다.",
};

export const REVOKE_WARNING_TEXT =
  "이 폴더의 파일은 디스크에 그대로 남습니다. 제품이 가져온 내용과 거기서 나온 지식은 지워지며 되돌릴 수 없습니다";
export const CONFIRM_DELETIONS_WARNING_TEXT =
  "디스크에서 사라진 파일입니다. 반영하면 제품이 가져온 내용과 거기서 나온 지식은 지워지며 되돌릴 수 없습니다";

/** Why a refused action did not run (409 codes of the location API). */
export const ACTION_REFUSAL_TEXT: Record<string, string> = {
  "count-mismatch": "그 사이 수가 바뀌었습니다. 목록을 새로 불러왔으니 수를 다시 확인해 주세요.",
  "ledger-degraded": "장부가 잠겨 있어 지우지 못했습니다. 아무것도 지워지지 않았습니다.",
  "ledger-unwritable": "장부에 적지 못해 지우지 못했습니다. 아무것도 지워지지 않았습니다.",
  "instance-busy":
    "지금 동기화가 돌고 있어 잠시 뒤에 다시 시도해 주세요. 아무것도 지워지지 않았습니다.",
  "not-lifted": "사용자가 지운 파일은 지운 원본의 삭제를 해제한 뒤에 다시 가져올 수 있습니다.",
};

export const ACTION_TEXT = {
  pause: "일시 중지",
  resume: "다시 켜기",
  rescan: "전체 다시 훑기",
  relink: "다시 연결",
  confirm: "삭제 반영",
  revoke: "승인 철회",
  revokeContinue: "철회 계속",
  skipped: "건너뛴 파일 보기",
  hideSkipped: "건너뛴 파일 닫기",
  reimport: "다시 가져오기",
} as const;
