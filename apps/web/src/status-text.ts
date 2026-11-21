// Home's words for each part's state (V01-R5: show what does not work). Embedding
// also names where texts are embedded, so a remote embedder reads as external egress.
import type { ComponentStatus, EmbeddingStatusEntry } from "@pki/contracts";

const STATE_LABEL = {
  ready: "준비됨",
  rebuilding: "재구성 중",
  preparing: "준비 중",
  "model-missing": "모델 없음, 키워드 검색으로 동작",
  unavailable: "사용 불가",
  "not-implemented": "미구현",
} as const;

const EGRESS_LABEL = { local: "로컬 계산", external: "외부 전송" } as const;

const stateText = (status: ComponentStatus | EmbeddingStatusEntry) =>
  status.state === "unavailable"
    ? `${STATE_LABEL.unavailable}: ${status.reason}`
    : STATE_LABEL[status.state];

export const componentText = (status: ComponentStatus) => stateText(status);

export function embeddingText(status: EmbeddingStatusEntry) {
  const egress = "egress" in status ? status.egress : undefined;
  return egress ? `${stateText(status)} (${EGRESS_LABEL[egress]})` : stateText(status);
}
