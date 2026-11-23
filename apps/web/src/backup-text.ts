// The Settings screen's "백업·복원" texts (H01-R16): why a request was refused, what the user must know before a
// backup and before a restore, and what the last restore did. One text per code; the key sets are the contract's
// lists and backup-text.test.ts pins them.
import type { RestoreLast, RestoreRefusalCode } from "@pki/contracts";
import type { BACKUP_FOLDER_REFUSALS, BACKUP_REFUSALS } from "@pki/contracts";

export const BACKUP_FOLDER_REFUSAL_TEXT: Record<(typeof BACKUP_FOLDER_REFUSALS)[number], string> = {
  "ticket-required": "폴더 선택 창에서 고른 폴더만 쓸 수 있습니다. 다시 선택해 주세요.",
  "not-a-folder": "폴더를 찾을 수 없습니다. 경로를 확인해 주세요.",
  "not-writable": "그 폴더에 쓸 수 없습니다. 쓰기 권한을 확인해 주세요.",
  "inside-data-folder":
    "이 앱의 데이터 폴더 안에는 백업을 둘 수 없습니다. 다른 폴더를 골라 주세요.",
};

export const BACKUP_REFUSAL_TEXT: Record<(typeof BACKUP_REFUSALS)[number], string> = {
  "weak-passphrase": "암호구는 12자 이상이어야 합니다.",
  "no-folder": "백업을 둘 폴더를 먼저 정해 주세요.",
  "folder-unusable": "정한 폴더를 쓸 수 없습니다. 폴더를 다시 정해 주세요.",
  "file-exists": "같은 이름의 백업 파일이 이미 있습니다. 잠시 뒤 다시 시도해 주세요.",
  failed: "백업하지 못했습니다. 지금 데이터는 그대로입니다.",
};

export const RESTORE_REFUSAL_TEXT: Record<RestoreRefusalCode, string> = {
  "wrong-passphrase": "암호구가 맞지 않습니다.",
  damaged: "백업 파일이 손상됐거나 바뀌었습니다. 지금 데이터는 그대로입니다.",
  "unsupported-format": "이 앱이 모르는 형식의 파일입니다.",
  "confirm-mismatch": "살펴본 백업과 다른 파일입니다. 다시 살펴본 뒤 복원해 주세요.",
  "newer-schema":
    "이 앱보다 새 버전에서 만든 백업이라 복원할 수 없습니다. 앱을 올린 뒤 시도해 주세요.",
  "other-installation":
    "다른 설치의 백업입니다. 이미 원본이나 삭제 기록이 있는 이 설치에는 복원할 수 없습니다.",
  "migration-failed":
    "옛 버전의 백업을 지금 버전으로 올리지 못했습니다. 지금 데이터는 그대로입니다.",
  "foreign-schema":
    "백업 안의 데이터베이스 구조가 이 앱이 만드는 것과 다릅니다(추가된 트리거나 뷰 등). 복원하지 않았고 지금 데이터는 그대로입니다.",
  "already-pending": "이미 적용을 기다리는 복원이 있습니다. 먼저 그 복원을 취소해 주세요.",
  "no-folder": "백업 폴더를 먼저 정해 주세요.",
  "bad-file-name": "백업 파일 이름이 올바르지 않습니다.",
  "not-found": "그 백업 파일을 찾을 수 없습니다.",
};

/** What the user is told, in the screen, before a backup and before a restore (H01-R16). */
export const BACKUP_WARNINGS: readonly string[] = [
  "암호구를 잃으면 백업 파일을 읽을 수 없고 되찾을 길이 없습니다. 암호구는 이 앱이 저장하지 않습니다.",
  "비밀 값(API 키 등)은 백업에 들어가지 않습니다. 다른 PC에 복원하면 다시 입력해야 합니다.",
  "복원은 앱을 다시 시작해야 적용됩니다. 그때까지 한 변경은 복원과 함께 사라집니다(삭제는 기록이 남아 다시 적용됩니다).",
  "지운 이전 version은 복원하면 되살아날 수 있습니다. 전송 동의는 모두 지워지니 다시 동의해야 합니다.",
  "복원하기 전에 지금 데이터를 먼저 백업해 두세요. 복원이 끝나면 지금 데이터는 지워지고 되돌릴 수 없습니다.",
];

/** One line on what the last restore did, from the numbers the start recorded (R12). */
export function restoreResultText(last: RestoreLast): string {
  const parts = [
    `백업(${last.backupCreatedAt})으로 복원했습니다.`,
    `백업 뒤의 삭제 ${last.reapplied}건을 다시 적용했고`,
    `읽던 폴더 ${last.pausedLocations}곳을 멈췄고`,
    `전송 동의 ${last.clearedConsents}건을 지웠습니다.`,
  ];
  if (last.embeddingSpaceDiffers) {
    parts.push("임베딩 공간이 달라 검색 색인을 다시 만듭니다.");
  }
  return parts.join(" ");
}
