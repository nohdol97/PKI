// Words for the Sources screen's delete request (V02-R12).
import type { RouteResponse } from "@pki/contracts";

export function deleteConfirmText(title: string): string {
  return `「${title}」의 모든 version과 그 근거, 이 원본에만 근거한 지식을 지웁니다. 지운 원본은 다시 가져올 수 없습니다.`;
}

export function deletedText(
  title: string,
  outcome: RouteResponse<"deleteSource">["outcome"],
): string {
  return outcome === "deleted"
    ? `「${title}」을(를) 지웠습니다.`
    : `「${title}」은(는) 이미 지워졌습니다.`;
}
