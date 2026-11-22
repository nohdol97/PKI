// Home's words for each part's state (V01-R5: show what does not work, and that
// keyword search still does). Embedding also names where texts are embedded, so a
// remote embedder reads as external egress. A reason Home does not know is shown
// as its code: every reason is a code or a fixed phrase, never adapter text.
import type { ComponentStatus, EmbeddingStatusEntry, ProviderStatus } from "@pki/contracts";
import type { RouteResponse } from "@pki/contracts";
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

/** Where a listed CLI with background calls off is let run imported data's extraction (T17 handoff 1). */
export const BACKGROUND_OFF_GUIDANCE =
  '설정 화면에서 "CLI 백그라운드 실행 허용"을 켜면 가져온 자료의 추출이 이 CLI로 실행됩니다. 연결 시험은 켜지 않아도 실행됩니다.';

/** The execution gate's reason codes (providers/src/execution-gate.ts), apart from egress. */
const EXECUTION_REASON = /^(cli|unverified)-/;

/**
 * The default Provider's state (T16): what its queries found, with the install or
 * login guidance Settings shows for the same finding, or why egress or the CLI
 * execution conditions stop it (T17).
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
  // the execution gate's reasons (T17 handoff 1); the ones a check finds came with it above
  const stopped = EXECUTION_REASON.test(status.reason) ? "실행이 막힘" : "전송이 막힘";
  return {
    text: `${name}: ${stopped}(${blockReasonText(status.reason)})`,
    guidance: status.reason === "cli-background-off" ? BACKGROUND_OFF_GUIDANCE : null,
  };
}

/** The pinned model the approval is for (T14 handoff 1·2): source host, size, the hash check. */
export const DOWNLOAD_APPROVAL =
  "huggingface.co(와 그곳이 넘겨 주는 내려받기 서버)에서 고정된 bge-m3 모델 파일 4개(합 약 586 MB)를 내려받습니다. 파일마다 크기와 해시가 고정 값과 맞을 때만 설치하고, 맞지 않으면 아무것도 설치하지 않습니다. 이 승인은 이번 한 번의 내려받기에만 쓰입니다.";

export const LOCAL_PACK_HINT =
  "로컬 팩: 모델 파일 4개가 든 폴더의 절대 경로입니다. 파일은 네트워크 없이 이 PC에서 읽고, 해시가 맞을 때만 설치합니다.";

/** Said once, before the first note about the ledger: what it is, in plain words. */
const LEDGER_EXPLAINED =
  "삭제 장부는 지운 자료가 백업을 복원한 뒤에 되살아나지 않도록, 삭제했다는 사실만 데이터 폴더에 따로 적어 두는 파일입니다(자료의 내용은 적지 않습니다)";

const HISTORY_TEXT = [
  ["missingCreated", "삭제 장부가 없어 새로 만듦"],
  ["setAside", "다른 설치의 장부를 옆에 둠"],
  ["unrecoverable", "다시 적용하지 못한 삭제"],
  ["ignoredLines", "읽지 못해 무시한 장부 줄"],
  ["reapplied", "시작 때 다시 적용한 삭제"],
  ["seeded", "장부에 뒤늦게 채운 삭제"],
] as const;

/**
 * The data-protection item (I04-R6): `pending` on a running backend means the clean-up
 * of earlier deletions' traces failed at this start (it starts after the backend's
 * database was prepared), and is tried again at the next one.
 */
export const dataProtectionText = (status: RouteResponse<"status">["dataProtection"]) => {
  const { ledger } = status;
  const notes: string[] = [];
  if (status.legacyCleanup === "pending")
    notes.push("이전 삭제의 흔적 정리 실패(다음 시작에 다시 시도)");
  const legacyNotes = notes.length;
  if (ledger.state === "degraded") {
    notes.push("삭제 장부를 쓰지 못해 데이터 변경을 막았습니다(앱을 다시 시작하면 풀립니다)");
  }
  if (ledger.state === "missing-created") {
    notes.push(
      "삭제 장부가 없어 새로 만들었습니다. 백업 뒤의 삭제는 다시 수집해야 반영되며, 수집기가 전체 재스캔에서 삭제를 알리지 못하면 반영되지 않을 수 있습니다",
    );
  }
  if (ledger.setAsideLedgers > 0) {
    notes.push(
      `다른 설치의 삭제 장부 ${ledger.setAsideLedgers}개(삭제 ${ledger.setAsideDeletions}건)는 적용하지 않고 옆에 두었습니다`,
    );
  }
  if (ledger.unrecoverable > 0) {
    notes.push(`다시 적용하지 못한 삭제 ${ledger.unrecoverable}건(연결 정보 없음)`);
  }
  if (ledger.ignoredLines > 0) {
    notes.push(`읽지 못해 무시한 삭제 장부 줄 ${ledger.ignoredLines}개`);
  }
  if (ledger.reapplied > 0) {
    notes.push(`시작할 때 삭제 ${ledger.reapplied}건을 다시 적용했습니다`);
  }
  const ledgerNotes = notes.slice(legacyNotes);
  const head =
    notes.length === 0
      ? "정상"
      : [
          ...notes.slice(0, legacyNotes),
          ...(ledgerNotes.length > 0 ? [LEDGER_EXPLAINED, ...ledgerNotes] : []),
        ].join(" / ");
  // what happened at earlier starts does not vanish when the current state is ok again
  const past = HISTORY_TEXT.flatMap(([name, label]) => {
    const entry = ledger.history[name];
    return entry.total > 0 && entry.last !== null
      ? [
          `${label} ${entry.total}${name === "missingCreated" ? "번" : "건"}(마지막 발생: ${entry.last.slice(0, 10)})`,
        ]
      : [];
  });
  if (past.length === 0) return head;
  // the history is about the ledger too: explain it once if no current note already did
  const explain = ledgerNotes.length > 0 ? "" : `${LEDGER_EXPLAINED}. `;
  return `${head} · ${explain}지난 기록: ${past.join(", ")}`;
};
