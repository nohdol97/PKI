// Home's words for each part's state (V01-R5: show what does not work, and that
// keyword search still does). Embedding also names where texts are embedded, so a
// remote embedder reads as external egress. A reason Home does not know is shown
// as its code: every reason is a code or a fixed phrase, never adapter text.
import type { ComponentStatus, EmbeddingStatusEntry, ProviderStatus } from "@pki/contracts";
import { blockReasonText } from "./connection-test-text.ts";
import { providerCheckText, providerName } from "./provider-text.ts";

const STATE_LABEL = {
  ready: "준비됨",
  rebuilding: "재구성 중",
  preparing: "준비 중",
  "model-missing": "모델 없음, 키워드 검색으로 동작",
  unavailable: "사용 불가",
  "not-implemented": "미구현",
} as const;

const EGRESS_LABEL = { local: "로컬 계산", external: "외부 전송" } as const;

const KEYWORD_ONLY = "키워드 검색으로 동작";

/** The embedder's and the vector index's fixed reasons (T14 handoff 4, storage EmptyVectorIndex). */
const REASON: Readonly<Record<string, string>> = {
  "model file missing": "모델 파일이 없음",
  "model file hash mismatch": "모델 파일이 고정 값과 다름",
  // also a proxy's refusal or a final address that is not https (T14 handoff 2)
  "model download failed": "모델을 내려받지 못함(네트워크·프록시 확인)",
  "model install failed": "모델을 설치하지 못함",
  "embedding runtime failed to load": "실행 모듈을 불러오지 못함",
  "status check failed": "상태를 읽지 못함",
  "no vector index module in this build": "이 빌드에는 벡터 색인이 없음",
};

const stateText = (status: ComponentStatus | EmbeddingStatusEntry) =>
  status.state === "unavailable"
    ? `${STATE_LABEL.unavailable}: ${REASON[status.reason] ?? status.reason}`
    : STATE_LABEL[status.state];

export const componentText = (status: ComponentStatus) => stateText(status);

/** Without a vector index, search falls back to keywords (V01-R15). */
export const vectorIndexText = (status: ComponentStatus) =>
  status.state === "unavailable" ? `${stateText(status)}, ${KEYWORD_ONLY}` : stateText(status);

export function embeddingText(status: EmbeddingStatusEntry) {
  const egress = "egress" in status ? status.egress : undefined;
  const text =
    status.state === "unavailable" ? `${stateText(status)}, ${KEYWORD_ONLY}` : stateText(status);
  return egress ? `${text} (${EGRESS_LABEL[egress]})` : text;
}

/**
 * The default Provider's state (T16): what its queries found, with the install or
 * login guidance Settings shows for the same finding, or why egress stops it.
 */
export function providerStatusText(status: ProviderStatus): {
  text: string;
  guidance: string | null;
} {
  if (status.state === "unavailable" && status.reason === "status-check-failed") {
    return { text: "상태를 읽지 못함", guidance: null };
  }
  if (status.providerId === null) {
    return { text: "기본 Provider가 정해지지 않음. 설정 화면에서 고르세요.", guidance: null };
  }
  const name = providerName(status.providerId);
  if (status.check) {
    const { state, guidance } = providerCheckText(status.check);
    return { text: `${name}: ${state}`, guidance };
  }
  if (status.state === "ready") return { text: `${name}: 사용 가능`, guidance: null };
  return { text: `${name}: 전송이 막힘(${blockReasonText(status.reason)})`, guidance: null };
}

/** The pinned model the approval is for (T14 handoff 1·2): source host, size, the hash check. */
export const DOWNLOAD_APPROVAL =
  "huggingface.co(와 그곳이 넘겨 주는 내려받기 서버)에서 고정된 bge-m3 모델 파일 4개(합 약 586 MB)를 내려받습니다. 파일마다 크기와 해시가 고정 값과 맞을 때만 설치하고, 맞지 않으면 아무것도 설치하지 않습니다. 이 승인은 이번 한 번의 내려받기에만 쓰입니다.";

export const LOCAL_PACK_HINT =
  "로컬 팩: 모델 파일 4개가 든 폴더의 절대 경로입니다. 파일은 네트워크 없이 이 PC에서 읽고, 해시가 맞을 때만 설치합니다.";
