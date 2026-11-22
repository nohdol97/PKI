// Words for the Sources screen's delete request (V02-R12).
import type { RouteResponse } from "@pki/contracts";

export function deleteConfirmText(title: string): string {
  return `「${title}」의 모든 version과 그 근거, 이 원본에만 근거한 지식을 지웁니다. 지운 원본은 다시 가져올 수 없습니다.`;
}

/** A deletion the ledger could not record (I04-R17): not done, with its fixed reason; no id in the text. */
export const notDeletedText = (title: string): string =>
  `「${title}」은(는) 지우지 못했습니다. 이 원본의 연결 정보를 삭제 장부에 적을 수 없는 형식이라 삭제를 허용하지 않았습니다(장부 없이 지우면 백업을 복원할 때 되살아날 수 있습니다). 원본은 그대로 남아 있습니다.`;

export function deletedText(
  title: string,
  outcome: RouteResponse<"deleteSource">["outcome"],
): string {
  return outcome === "deleted"
    ? `「${title}」을(를) 지웠습니다.`
    : `「${title}」은(는) 이미 지워졌습니다.`;
}
