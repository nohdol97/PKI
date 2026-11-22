// The Activity screen's job area (I03-R23): counts per status, the job list with its
// reasons, the periods, the projections' rebuild state, the Broker's call budget and the
// queue warning; and what the user can do: cancel, try again, discard (asked first), change,
// turn off and on, and run a period now, and rebuild a projection. Every value arrives as a
// code, an id or a count and is rendered as text; nothing here builds markup from data.
import type {
  JobSummary,
  JobsResponse,
  ProjectionActivity,
  ScheduleSummary,
  SchedulePeriod,
} from "@pki/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiClient } from "./api.ts";
import {
  type ActionKind,
  discardStep,
  runAction,
  BACKLOG_WARNING,
  budgetText,
  discardConfirmText,
  isMarkingRemoval,
  jobNote,
  MARKING_REMOVAL,
  unreadableText,
  kindText,
  periodText,
  projectionText,
  reasonText,
  resultCountsText,
  scheduleStateText,
  STATUS_ORDER,
  statusText,
} from "./job-text.ts";

const NONE = "—";
const CANCELLABLE: readonly JobSummary["status"][] = ["queued", "retry", "held", "running"];
const RETRYABLE: readonly JobSummary["status"][] = ["held", "dead_letter"];

const targetText = (job: Pick<JobSummary, "target" | "sourceId">) =>
  job.target !== "" ? job.target : job.sourceId !== null ? `원본 #${job.sourceId}` : NONE;

export interface JobsViewActions {
  cancel(id: number): void;
  retry(id: number): void;
  /** Asks first (the screen's confirmation), then discards. */
  askDiscard(id: number): void;
  runSchedule(id: number): void;
  setScheduleEnabled(id: number, enabled: boolean): void;
  changeSchedule(id: number, period: SchedulePeriod): void;
  rebuild(name: string): void;
}

export function JobsView({ data, actions }: { data: JobsResponse; actions: JobsViewActions }) {
  return (
    <section aria-label="작업">
      {data.backlog.warning && (
        <p role="alert">{BACKLOG_WARNING(data.backlog.open, data.backlog.cap)}</p>
      )}
      <ul aria-label="상태별 작업 수">
        {STATUS_ORDER.map((status) => (
          <li key={status}>
            {statusText(status)} {data.counts[status] ?? 0}
          </li>
        ))}
      </ul>
      <p>
        끝나지 않은 작업 {data.backlog.open} / {data.backlog.cap}건
      </p>
      {data.budget && <p>{budgetText(data.budget)}</p>}

      <h3>작업 목록</h3>
      {data.jobs.length === 0 ? (
        <p>작업이 없습니다.</p>
      ) : (
        <table aria-label="작업 목록">
          <thead>
            <tr>
              <th>번호</th>
              <th>종류</th>
              <th>대상</th>
              <th>상태</th>
              <th>시도</th>
              <th>다음 실행</th>
              <th>사유</th>
              <th>결과</th>
              <th>동작</th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((job) => (
              <JobRow key={job.id} job={job} actions={actions} />
            ))}
          </tbody>
        </table>
      )}
      {data.truncated && <p>최근 작업만 보입니다.</p>}
      {data.unreadable > 0 && <p role="alert">{unreadableText(data.unreadable)}</p>}

      <h3>주기</h3>
      {data.schedules.length === 0 ? (
        <p>등록된 주기가 없습니다.</p>
      ) : (
        <table aria-label="주기 목록">
          <thead>
            <tr>
              <th>번호</th>
              <th>종류</th>
              <th>주기</th>
              <th>상태</th>
              <th>마지막 실행</th>
              <th>다음 예정</th>
              <th>합쳐진 수</th>
              <th>건너뛴 수</th>
              <th>동작</th>
            </tr>
          </thead>
          <tbody>
            {data.schedules.map((schedule) => (
              <ScheduleRow key={schedule.id} schedule={schedule} actions={actions} />
            ))}
          </tbody>
        </table>
      )}

      <h3>투영</h3>
      {data.projections.length === 0 ? (
        <p>재구축이 필요한 투영이 없습니다.</p>
      ) : (
        <ul aria-label="투영 상태">
          {data.projections.map((projection) => (
            <ProjectionItem key={projection.name} projection={projection} actions={actions} />
          ))}
        </ul>
      )}
    </section>
  );
}

function JobRow({ job, actions }: { job: JobSummary; actions: JobsViewActions }) {
  const note = jobNote(job);
  const counts = resultCountsText(job.kind, job.resultCounts);
  return (
    <tr>
      <th scope="row">{job.id}</th>
      <td>{kindText(job.kind)}</td>
      <td>{targetText(job)}</td>
      <td>
        {statusText(job.status)}
        {job.cancelRequested && job.status === "running" ? " (취소 요청됨)" : ""}
      </td>
      <td>
        {job.attempts} / {job.maxAttempts}
      </td>
      <td>{job.status === "queued" || job.status === "retry" ? job.runAfter : NONE}</td>
      <td>
        {job.reason === null ? NONE : reasonText(job.reason)}
        {note && <p>{note}</p>}
      </td>
      <td>{counts || NONE}</td>
      <td>
        {isMarkingRemoval(job) && <p>{MARKING_REMOVAL}</p>}
        {CANCELLABLE.includes(job.status) && !isMarkingRemoval(job) && (
          <button
            type="button"
            aria-label={`작업 ${job.id} 취소`}
            onClick={() => actions.cancel(job.id)}
          >
            취소
          </button>
        )}
        {RETRYABLE.includes(job.status) && (
          <button
            type="button"
            aria-label={`작업 ${job.id} 다시 시도`}
            onClick={() => actions.retry(job.id)}
          >
            다시 시도
          </button>
        )}
        {job.status === "dead_letter" && !isMarkingRemoval(job) && (
          <button
            type="button"
            aria-label={`작업 ${job.id} 버리기`}
            onClick={() => actions.askDiscard(job.id)}
          >
            버리기
          </button>
        )}
      </td>
    </tr>
  );
}

function ScheduleRow({
  schedule,
  actions,
}: {
  schedule: ScheduleSummary;
  actions: JobsViewActions;
}) {
  const subject = `${kindText(schedule.kind)}${schedule.target ? ` ${schedule.target}` : ""}`;
  return (
    <tr>
      <th scope="row">{schedule.id}</th>
      <td>{subject}</td>
      <td>
        {periodText(schedule.period)} ({schedule.zone})
      </td>
      <td>
        {scheduleStateText(schedule)}
        {schedule.warning && <p>마지막 실행 실패: {reasonText(schedule.warning)}</p>}
      </td>
      <td>{schedule.lastRunSlot ?? NONE}</td>
      <td>{schedule.enabled ? schedule.nextDue : NONE}</td>
      <td>{schedule.counts.coalesced + schedule.counts.heldCoalesced}</td>
      <td>
        {schedule.counts.skipped}
        {schedule.lastMissed > 0 && <p>놓친 주기 {schedule.lastMissed}회</p>}
      </td>
      <td>
        <button
          type="button"
          aria-label={`주기 ${schedule.id} 지금 실행`}
          onClick={() => actions.runSchedule(schedule.id)}
        >
          지금 실행
        </button>
        <button
          type="button"
          aria-label={`주기 ${schedule.id} ${schedule.enabled ? "끄기" : "다시 켜기"}`}
          onClick={() => actions.setScheduleEnabled(schedule.id, !schedule.enabled)}
        >
          {schedule.enabled ? "끄기" : "다시 켜기"}
        </button>
        <PeriodForm schedule={schedule} change={actions.changeSchedule} />
      </td>
    </tr>
  );
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;
const PERIOD_KINDS = [
  ["every-10-minutes", "10분마다"],
  ["hourly", "1시간마다"],
  ["daily", "매일"],
  ["weekly", "매주"],
] as const;
const timeValue = (period: SchedulePeriod) =>
  "at" in period
    ? `${String(period.at.hour).padStart(2, "0")}:${String(period.at.minute).padStart(2, "0")}`
    : "03:00";

/** The period of a form's three fields; undefined while the time is not a valid "HH:MM". */
function periodOf(
  kind: SchedulePeriod["kind"],
  time: string,
  weekday: number,
): SchedulePeriod | undefined {
  if (kind === "every-10-minutes" || kind === "hourly") return { kind };
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return undefined;
  const at = { hour: Number(match[1]), minute: Number(match[2]) };
  if (kind === "daily") return { kind, at };
  return weekday >= 0 && weekday <= 6
    ? { kind, weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6, at }
    : undefined;
}

function PeriodForm({
  schedule,
  change,
}: {
  schedule: ScheduleSummary;
  change: JobsViewActions["changeSchedule"];
}) {
  const [kind, setKind] = useState<SchedulePeriod["kind"]>(schedule.period.kind);
  const [time, setTime] = useState(timeValue(schedule.period));
  const [weekday, setWeekday] = useState<number>(
    schedule.period.kind === "weekly" ? schedule.period.weekday : 1,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const period = periodOf(kind, time, weekday);
    if (period) change(schedule.id, period);
  };
  return (
    <form aria-label={`주기 ${schedule.id} 바꾸기`} onSubmit={submit}>
      <select
        aria-label={`주기 ${schedule.id} 종류`}
        value={kind}
        onChange={(e) => setKind(e.target.value as SchedulePeriod["kind"])}
      >
        {PERIOD_KINDS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {kind === "weekly" && (
        <select
          aria-label={`주기 ${schedule.id} 요일`}
          value={weekday}
          onChange={(e) => setWeekday(Number(e.target.value))}
        >
          {WEEKDAYS.map((name, index) => (
            <option key={name} value={index}>
              {name}요일
            </option>
          ))}
        </select>
      )}
      {(kind === "daily" || kind === "weekly") && (
        <input
          type="time"
          aria-label={`주기 ${schedule.id} 시각`}
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
      )}
      <button type="submit">주기 바꾸기</button>
    </form>
  );
}

function ProjectionItem({
  projection,
  actions,
}: {
  projection: ProjectionActivity;
  actions: JobsViewActions;
}) {
  return (
    <li>
      {projection.name}: {projectionText(projection)}{" "}
      <button
        type="button"
        aria-label={`투영 ${projection.name} 재구축`}
        onClick={() => actions.rebuild(projection.name)}
      >
        재구축
      </button>
    </li>
  );
}

/** The area with its data and actions: reads the job API, asks before a discard, says what each action did. */
export function JobsArea({ api, onRefresh }: { api: ApiClient; onRefresh?: () => void }) {
  const [data, setData] = useState<JobsResponse>();
  const [loadError, setLoadError] = useState<string>();
  const [action, setAction] = useState<{ text: string; failed: boolean }>();
  const [discarding, setDiscarding] = useState<number>();
  const load = useCallback(() => {
    api("jobs").then(
      (next) => {
        setData(next);
        setLoadError(undefined);
      },
      (failure: unknown) =>
        setLoadError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [api]);
  useEffect(load, [load]);

  /** Runs one action, says its outcome or why it failed, and reads the area again: a job may be gone by now. */
  const act = (kind: ActionKind, call: () => Promise<{ outcome: string }>) => {
    setDiscarding(undefined);
    void runAction(kind, call).then((result) => {
      setAction(result);
      load();
    });
  };
  const step = (event: Parameters<typeof discardStep>[1]) => {
    const { next, send } = discardStep(discarding, event);
    setDiscarding(next);
    if (send !== undefined) act("discard", () => api("discardJob", { id: send }));
  };

  const actions: JobsViewActions = {
    cancel: (id) => act("cancel", () => api("cancelJob", { id })),
    retry: (id) => act("retry", () => api("retryJob", { id })),
    askDiscard: (id) => {
      setAction(undefined);
      step({ type: "ask", id });
    },
    runSchedule: (id) => act("runSchedule", () => api("runSchedule", { id })),
    setScheduleEnabled: (id, enabled) =>
      act("schedule", () => api(enabled ? "enableSchedule" : "disableSchedule", { id })),
    changeSchedule: (id, period) => act("schedule", () => api("changeSchedule", { id, period })),
    rebuild: (name) => act("rebuild", () => api("rebuildProjection", { projection: name })),
  };
  return (
    <>
      <h2>작업</h2>
      <p>
        <button
          type="button"
          onClick={() => {
            load();
            onRefresh?.();
          }}
        >
          새로 고침
        </button>
      </p>
      {loadError && <p role="alert">불러오지 못했습니다: {loadError}</p>}
      {action && <p role={action.failed ? "alert" : "status"}>{action.text}</p>}
      {discarding !== undefined && (
        <div role="alertdialog" aria-label="작업 버리기 확인">
          <p>{discardConfirmText(discarding)}</p>
          <button type="button" onClick={() => step({ type: "confirm" })}>
            버리기
          </button>
          <button type="button" onClick={() => step({ type: "cancel" })}>
            취소
          </button>
        </div>
      )}
      {data && <JobsView data={data} actions={actions} />}
    </>
  );
}
