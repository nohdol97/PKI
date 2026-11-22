// The Activity screen's words for jobs, schedules and projections (I03-R23). Every value
// the job API sends is a code, an id or a count; each code gets a fixed text here, and a
// code this file does not know is shown as itself. Nothing a source, a Connector or a
// Provider wrote is ever turned into a sentence: the API never carries it.
import type {
  JobStatusValue,
  JobSummary,
  JobsResponse,
  ProjectionActivity,
  ScheduleSummary,
  SchedulePeriod,
  SyncStopCode,
} from "@pki/contracts";
import { DELETIONS_MAY_BE_MISSED, SYNC_STOP_TEXT } from "./connector-text.ts";

const KIND: Readonly<Record<string, string>> = {
  extract: "추출",
  "connector-sync": "동기화",
  maintenance: "정리",
  "projection-remove": "투영 제거",
  "projection-rebuild": "투영 재구축",
};
export const kindText = (kind: string): string => KIND[kind] ?? kind;

const STATUS: Readonly<Record<JobStatusValue, string>> = {
  queued: "대기",
  running: "실행 중",
  retry: "재시도 대기",
  held: "보류",
  succeeded: "성공",
  superseded: "대체됨",
  cancelled: "취소됨",
  dead_letter: "포기",
};
export const statusText = (status: JobStatusValue): string => STATUS[status];

/** The order the counts are shown in. */
export const STATUS_ORDER = Object.keys(STATUS) as JobStatusValue[];

/** Why a job is held, retrying, given up, skipped or dropped. The sync stop codes use the Sources screen's sentences (I01-T03). */
const REASON: Readonly<Record<string, string>> = {
  // held by the Broker's decision or the execution gate (held-release.ts HELD_REASONS)
  "no-consent": "Provider 전송 동의가 없음",
  "consent-stale-destination": "동의한 전송 대상이 바뀜",
  "consent-stale-policy": "동의한 뒤 정책 버전이 바뀜",
  "rule-denied": "정책이 이 자료의 전송을 허용하지 않음",
  "no-matching-rule": "이 자료에 맞는 정책 규칙이 없음",
  "destination-unavailable": "전송 대상을 쓸 수 없음",
  "insecure-endpoint": "안전하지 않은 주소",
  "cli-background-off": "CLI 백그라운드 실행이 꺼져 있음",
  "cli-not-verified": "검증되지 않은 CLI 버전",
  "cli-unknown": "CLI 버전을 확인할 수 없음",
  "capabilities-unavailable": "Provider 기능을 확인할 수 없음",
  "structured-output-unsupported": "Provider가 구조화된 출력을 지원하지 않음",
  "no-provider": "기본 Provider가 없음",
  "unverified-background": "검증되지 않은 CLI는 백그라운드로 실행할 수 없음(개발 빌드)",
  "unverified-not-synthetic": "검증되지 않은 CLI는 합성 자료만 받음(개발 빌드)",
  "unverified-malicious": "검증되지 않은 CLI는 악성일 수 있는 자료를 받지 않음(개발 빌드)",
  "unverified-ack-required": "검증되지 않은 CLI는 사용자 확인이 필요함(개발 빌드)",
  "source-too-large": "원본이 너무 커서 추출하지 않음",
  // held because the Connector instance cannot run (I03-T09)
  "unsupported-sdk-version": "수집기가 다른 SDK 버전용이라 실행할 수 없음",
  "connector-unavailable": "수집기를 초기화하지 못해 실행할 수 없음",
  "not-implemented": "배포처 수집기가 아직 구현되지 않음",
  "manager-not-ready": "수집기 관리자가 아직 준비되지 않아 잠시 미룸",
  "instance-not-found": "설정에서 사라진 수집기의 작업",
  "unmapped-sync-end": "알 수 없는 동기화 종료",
  // failures and waits
  "handler-error": "작업 처리 중 오류가 나서 다시 시도함",
  "invalid-reason": "작업이 올바르지 않은 사유를 내서 포기함",
  "invalid-output": "Provider 출력이 규격에 맞지 않아 포기함",
  "yield-no-progress": "진행 없이 양보만 되풀이해 다시 시도함",
  cancelled: "취소 신호로 멈춰 다시 시도함",
  "run-timeout": "실행 시간 제한을 넘겨 다시 시도함",
  "budget-exhausted": "Provider 호출 예산을 다 써서 기다림",
  "job-budget-exhausted": "이 작업이 한 번에 쓸 수 있는 호출을 다 씀",
  "rate-limited": "원 시스템이나 Provider의 요청 한도로 기다림",
  "missing-source": "원본이 사라짐",
  "missing-version": "대상 version이 사라짐",
  "dependency-delay": "앞선 작업을 기다림",
  "write-error": "결과를 저장하지 못해 다시 시도함",
  "engine-error": "지식 엔진 오류로 다시 시도함",
  // projections (I03-R7, I04-T04)
  "adapter-unavailable": "이 구현은 영구히 없는 투영이라 제거를 건너뜀(성공 처리)",
  "projection-unavailable": "투영을 지금 쓸 수 없어 다시 시도함(재구축 표식이 남음)",
  "stale-fence": "제거 요청이 낡아 다시 시도함",
  "projection-error": "투영 오류로 다시 시도함",
  "unknown-projection": "이 빌드가 모르는 투영이라 다시 시도함",
  "covered-by-rebuild": "재구축이 이 제거를 덮음",
  "lineage-covered": "추출 결과가 지워진 원본에 기댄 항목이라 버려짐",
  "storage-failed": SYNC_STOP_TEXT["storage-failed"],
};

/** A code with its meaning and the code beside it; a code this file does not know, as itself. */
export function reasonText(code: string): string {
  const stop = (SYNC_STOP_TEXT as Record<string, string | undefined>)[code as SyncStopCode];
  const meaning = stop ?? REASON[code];
  return meaning === undefined ? code : `${meaning} (${code})`;
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"] as const;
const two = (n: number) => String(n).padStart(2, "0");
const clock = (at: { hour: number; minute: number }) => `${two(at.hour)}:${two(at.minute)}`;

export function periodText(period: SchedulePeriod): string {
  switch (period.kind) {
    case "every-10-minutes":
      return "10분마다";
    case "hourly":
      return "1시간마다";
    case "daily":
      return `매일 ${clock(period.at)}`;
    case "weekly":
      return `매주 ${WEEKDAY[period.weekday]}요일 ${clock(period.at)}`;
  }
}

/** On or off, and why a period that is on registers nothing (I03-R20). */
export function scheduleStateText(schedule: Pick<ScheduleSummary, "enabled" | "pause">): string {
  if (!schedule.enabled) return "꺼짐";
  if (schedule.pause?.kind === "failed") {
    return `멈춤(포기: ${reasonText(schedule.pause.code)})`;
  }
  if (schedule.pause?.kind === "held") {
    return `멈춤(보류: ${reasonText(schedule.pause.reason)})`;
  }
  return "켜짐";
}

const COUNT_LABEL: Readonly<Record<string, string>> = {
  received: "받은 변경",
  created: "새 version",
  unchanged: "변경 없음",
  scopeUpdated: "범위 갱신",
  stale: "오래된 변경",
  staleTombstone: "지연된 삭제(적용 안 됨)",
  blocked: "막힘",
  tombstoned: "삭제 표식",
  rejected: "거부",
  purged: "정리한 기록",
  covered: "덮은 제거",
};
/** The counts shown for a kind, in this order; the marks (`rescanned`, `deletionsMayBeMissed`) are words, not counts. */
const SHOWN_COUNTS: Readonly<Record<string, readonly string[]>> = {
  "connector-sync": [
    "received",
    "created",
    "unchanged",
    "scopeUpdated",
    "stale",
    "staleTombstone",
    "blocked",
    "tombstoned",
    "rejected",
  ],
  maintenance: ["purged"],
  "projection-rebuild": ["covered"],
};

/** What a finished run counted, in words; "" when the job holds none to show. */
export function resultCountsText(
  kind: string,
  counts: Readonly<Record<string, number>> | null,
): string {
  if (counts === null) return "";
  const parts = (SHOWN_COUNTS[kind] ?? []).flatMap((key) =>
    counts[key] === undefined ? [] : [`${COUNT_LABEL[key]} ${counts[key]}건`],
  );
  if (kind === "connector-sync") {
    if (counts.rescanned === 1) parts.push("다시 훑음");
    if (counts.deletionsMayBeMissed === 1) parts.push(DELETIONS_MAY_BE_MISSED);
  }
  return parts.join(", ");
}

/** A note on a row beyond its status and reason. */
export function jobNote(job: Pick<JobSummary, "status" | "reason" | "target">): string | undefined {
  // I04-T06: the re-extraction was dropped by lineage too, so that version stays unextracted
  return job.status === "superseded" &&
    job.reason === "lineage-covered" &&
    job.target.startsWith("lineage-retry:")
    ? "추출되지 않은 version"
    : undefined;
}

export function projectionText(projection: ProjectionActivity): string {
  const parts = [
    projection.rebuild === "repeating"
      ? "재구축 반복 중(투영 사용 불가)"
      : projection.rebuild === "pending"
        ? "재구축 대기"
        : undefined,
    projection.openRemoves > 0 ? `제거 진행 ${projection.openRemoves}건` : undefined,
    projection.deadRemoves > 0 ? `제거 포기 ${projection.deadRemoves}건` : undefined,
  ].filter((part) => part !== undefined);
  return parts.join(", ");
}

export function budgetText(budget: NonNullable<JobsResponse["budget"]>): string {
  const minutes = Math.round(budget.windowMs / 60_000);
  const head = `최근 ${minutes}분 동안 Provider 호출 ${budget.used} / ${budget.maxCalls}회`;
  return budget.resetsAt === null ? head : `${head}, 다음 빈 자리 ${budget.resetsAt}`;
}

export const BACKLOG_WARNING = (open: number, cap: number) =>
  `끝나지 않은 작업이 ${open}건으로 상한 ${cap}건의 90%를 넘었습니다. 상한에 닿으면 주기 작업이 건너뛰어집니다.`;

type ActionKind = "cancel" | "retry" | "discard" | "runSchedule" | "rebuild" | "schedule";
const GONE = "작업을 찾을 수 없습니다. 끝난 지 30일이 지난 기록은 정리됩니다.";
const UNAVAILABLE = "지금은 사용할 수 없습니다.";
const OUTCOME: Readonly<Record<ActionKind, Readonly<Record<string, string>>>> = {
  cancel: {
    cancelled: "취소했습니다.",
    requested: "취소를 요청했습니다. 실행 중인 작업이 멈추는 대로 반영됩니다.",
    finished: "이미 끝난 작업입니다.",
    "not-cancellable": "취소할 수 없는 상태입니다. 포기한 작업은 버리기를 쓰세요.",
    "not-found": GONE,
  },
  retry: {
    queued: "다시 대기열에 넣었습니다.",
    "not-retryable": "다시 시도할 수 없는 상태입니다.",
    "duplicate-open": "같은 작업이 이미 진행 중이거나 대기 중입니다.",
    "not-found": GONE,
  },
  discard: {
    discarded: "버렸습니다.",
    "not-dead-letter": "포기한 작업만 버릴 수 있습니다.",
    "not-found": GONE,
  },
  runSchedule: {
    started: "지금 실행하도록 등록했습니다.",
    "already-open": "이 주기의 작업이 이미 진행 중이거나 대기 중입니다.",
    "not-found": "주기를 찾을 수 없습니다.",
  },
  rebuild: {
    requested: "재구축을 등록했습니다.",
    "already-open": "이 투영의 재구축이 이미 진행 중이거나 대기 중입니다.",
    "unknown-projection": "알 수 없는 투영입니다.",
  },
  schedule: { done: "반영했습니다.", "not-found": "주기를 찾을 수 없습니다." },
};

export function actionText(kind: ActionKind, outcome: string): string {
  return outcome === "unavailable" ? UNAVAILABLE : (OUTCOME[kind][outcome] ?? outcome);
}

/** The question before a given-up job is discarded: it cannot be taken back. */
export const discardConfirmText = (id: number): string =>
  `포기한 작업 ${id}번을 버립니다. 버린 작업은 되살릴 수 없고, 다시 하려면 새로 등록되어야 합니다.`;

/** I04-R4: the status API's invalidation records; `scopePolicyDrops` only once I04-T09 supplies it. */
export function invalidationText(invalidations: {
  recent: readonly unknown[];
  scopePolicyDrops?: number | undefined;
}): string {
  const recent = `최근 무효화 기록 ${invalidations.recent.length}건`;
  return invalidations.scopePolicyDrops === undefined
    ? recent
    : `${recent}, 범위 정책으로 빠진 항목 ${invalidations.scopePolicyDrops}건`;
}
