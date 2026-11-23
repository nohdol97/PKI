// The Settings screen's "로컬 자료" texts (I02B-R38): why an approval was refused, what a location's state
// is, and the two fixed marks of this release. One text per code; the key set is the contract's list
// (`APPROVAL_REJECTION_TEXT` is total by type, local-locations-text.test.ts pins the runtime keys).
import type { LocalApprovalRejectionCode, LocalLocationInfo } from "@pki/contracts";

export const APPROVAL_REJECTION_TEXT: Record<LocalApprovalRejectionCode, string> = {
  "not-absolute": "전체 경로(맨 앞이 폴더 이름이 아니라 드라이브나 / 로 시작하는 경로)를 적어야 합니다.",
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
