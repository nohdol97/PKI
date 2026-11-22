// I03-R23: what the Activity screen's job area shows for a job API answer, and which actions each
// row offers. A value from the API is rendered as text: a hostile target stays text.
import type { JobsResponse } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobsView, type JobsViewActions } from "./activity-jobs.tsx";
import { DELETIONS_MAY_BE_MISSED } from "./connector-text.ts";

const noop = () => {};
const actions: JobsViewActions = {
  cancel: noop,
  retry: noop,
  askDiscard: noop,
  runSchedule: noop,
  setScheduleEnabled: noop,
  changeSchedule: noop,
  rebuild: noop,
};

const job = (over: Partial<JobsResponse["jobs"][number]>): JobsResponse["jobs"][number] => ({
  id: 1,
  kind: "maintenance",
  target: "",
  sourceId: null,
  status: "queued",
  reason: null,
  attempts: 0,
  maxAttempts: 5,
  priority: "scheduled",
  runAfter: "2026-11-21T01:00:00.000Z",
  finishedAt: null,
  cancelRequested: false,
  resultCounts: null,
  ...over,
});
const response = (over: Partial<JobsResponse> = {}): JobsResponse => ({
  counts: {
    queued: 1,
    running: 0,
    retry: 0,
    held: 2,
    succeeded: 0,
    superseded: 0,
    cancelled: 0,
    dead_letter: 1,
  },
  jobs: [],
  truncated: false,
  schedules: [],
  projections: [],
  budget: null,
  backlog: { open: 4, cap: 1000, warning: false },
  ...over,
});
const render = (data: JobsResponse) =>
  renderToStaticMarkup(<JobsView data={data} actions={actions} />);
/** The row of job `id` as markup. */
const rowOf = (html: string, id: number) =>
  html.split("<tr>").find((row) => row.includes(`<th scope="row">${id}</th>`)) ?? "";

describe("JobsView", () => {
  it("shows the count of every status, zero included", () => {
    const html = render(response());
    expect(html).toContain("<li>대기 1</li>");
    expect(html).toContain("<li>보류 2</li>");
    expect(html).toContain("<li>포기 1</li>");
    expect(html).toContain("<li>취소됨 0</li>");
  });

  it("shows a held job's reason code with its meaning, the attempts and a queued job's next run time", () => {
    const html = render(
      response({
        jobs: [
          job({ id: 2, status: "held", reason: "no-consent", attempts: 1 }),
          job({ id: 1, status: "queued", runAfter: "2026-11-21T09:30:00.000Z" }),
        ],
      }),
    );
    expect(rowOf(html, 2)).toContain("Provider 전송 동의가 없음 (no-consent)");
    expect(rowOf(html, 2)).toContain("1 / 5");
    expect(rowOf(html, 1)).toContain("2026-11-21T09:30:00.000Z");
    // a held job has no next run time to show
    expect(rowOf(html, 2)).not.toContain("2026-11-21T01:00:00.000Z");
  });

  it("offers each row only the actions its status allows", () => {
    const statuses = [
      "queued",
      "running",
      "retry",
      "held",
      "succeeded",
      "superseded",
      "cancelled",
      "dead_letter",
    ] as const;
    const html = render(
      response({ jobs: statuses.map((status, i) => job({ id: i + 1, status })) }),
    );
    const offered = (id: number) =>
      ["취소", "다시 시도", "버리기"].filter((a) =>
        rowOf(html, id).includes(`aria-label="작업 ${id} ${a}"`),
      );
    expect(statuses.map((_, i) => offered(i + 1))).toEqual([
      ["취소"], // queued
      ["취소"], // running
      ["취소"], // retry
      ["취소", "다시 시도"], // held
      [], // succeeded
      [], // superseded
      [], // cancelled
      ["다시 시도", "버리기"], // dead_letter
    ]);
  });

  it("shows a sync's result counts with the stale-tombstone and blocked counts and the missed-deletions sentence (I01-R19)", () => {
    const html = render(
      response({
        jobs: [
          job({
            id: 3,
            kind: "connector-sync",
            target: "mail-1",
            status: "succeeded",
            resultCounts: {
              received: 5,
              staleTombstone: 2,
              blocked: 1,
              rescanned: 1,
              deletionsMayBeMissed: 1,
            },
          }),
        ],
      }),
    );
    const row = rowOf(html, 3);
    expect(row).toContain("지연된 삭제(적용 안 됨) 2건");
    expect(row).toContain("막힘 1건");
    expect(row).toContain(DELETIONS_MAY_BE_MISSED);
    expect(row).toContain("mail-1");
  });

  it("shows a removal skipped for an absent adapter and one retrying for an unavailable projection as different rows", () => {
    const html = render(
      response({
        jobs: [
          job({
            id: 5,
            kind: "projection-remove",
            target: "engine",
            sourceId: 9,
            status: "succeeded",
            reason: "adapter-unavailable",
          }),
          job({
            id: 4,
            kind: "projection-remove",
            target: "engine",
            sourceId: 8,
            status: "retry",
            reason: "projection-unavailable",
          }),
        ],
      }),
    );
    expect(rowOf(html, 5)).toContain("건너뜀");
    expect(rowOf(html, 5)).not.toContain("다시 시도함");
    expect(rowOf(html, 4)).toContain("다시 시도함");
    expect(rowOf(html, 4)).not.toContain("건너뜀");
  });

  it("marks a version whose re-extraction lineage dropped as not extracted", () => {
    const html = render(
      response({
        jobs: [
          job({
            id: 6,
            kind: "extract",
            sourceId: 3,
            target: "lineage-retry:2",
            status: "superseded",
            reason: "lineage-covered",
          }),
        ],
      }),
    );
    expect(rowOf(html, 6)).toContain("추출되지 않은 version");
  });

  it("renders a target as text: markup in it stays text, and a source is shown by its id", () => {
    const html = render(
      response({
        jobs: [
          job({ id: 7, kind: "connector-sync", target: "<img src=x onerror=alert(1)>" }),
          job({ id: 8, kind: "extract", sourceId: 41 }),
        ],
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(rowOf(html, 8)).toContain("원본 #41");
  });

  it("shows a period's merged and skipped counts and why it is paused, held ones included", () => {
    const base = {
      kind: "connector-sync",
      target: "mail-1",
      period: { kind: "hourly" },
      zone: "UTC",
      enabled: true,
      nextDue: "2026-11-21T02:00:00.000Z",
      lastRunSlot: "2026-11-21T01:00:00.000Z",
      lastMissed: 0,
      counts: { registered: 4, coalesced: 3, heldCoalesced: 2, skipped: 7, alreadyRan: 0 },
    } as const;
    const html = render(
      response({
        schedules: [
          { ...base, id: 1, pause: { kind: "held", reason: "connector-unavailable" } },
          { ...base, id: 2, pause: { kind: "failed", code: "handler-error" }, lastMissed: 2 },
        ],
      }),
    );
    const held = rowOf(html, 1);
    expect(held).toContain(
      "멈춤(보류: 수집기를 초기화하지 못해 실행할 수 없음 (connector-unavailable))",
    );
    expect(held).toContain("<td>5</td>"); // coalesced 3 + held-coalesced 2
    expect(held).toContain("<td>7</td>");
    expect(held).toContain("1시간마다");
    expect(rowOf(html, 2)).toContain("멈춤(포기: ");
    expect(rowOf(html, 2)).toContain("놓친 주기 2회");
    expect(held).toContain('aria-label="주기 1 지금 실행"');
    expect(held).toContain('aria-label="주기 1 끄기"');
  });

  it("offers to turn a period that is off back on, and shows no next run for it", () => {
    const html = render(
      response({
        schedules: [
          {
            id: 1,
            kind: "maintenance",
            target: "",
            period: { kind: "daily", at: { hour: 3, minute: 0 } },
            zone: "UTC",
            enabled: false,
            nextDue: "2026-11-22T03:00:00.000Z",
            lastRunSlot: null,
            lastMissed: 0,
            counts: { registered: 0, coalesced: 0, heldCoalesced: 0, skipped: 0, alreadyRan: 0 },
          },
        ],
      }),
    );
    expect(html).toContain('aria-label="주기 1 다시 켜기"');
    expect(html).toContain("꺼짐");
    expect(html).not.toContain("2026-11-22T03:00:00.000Z");
  });

  it("shows a projection's rebuild waiting or repeating, with the rebuild action", () => {
    const html = render(
      response({
        projections: [
          { name: "engine", openRemoves: 1, deadRemoves: 0, rebuild: "pending" },
          { name: "vector", openRemoves: 0, deadRemoves: 2, rebuild: "repeating" },
        ],
      }),
    );
    expect(html).toContain("engine: 재구축 대기, 제거 진행 1건");
    expect(html).toContain("vector: 재구축 반복 중(투영 사용 불가), 제거 포기 2건");
    expect(html).toContain('aria-label="투영 vector 재구축"');
  });

  it("warns about the queue only when the API says so, and shows the budget when there is one", () => {
    expect(render(response())).not.toContain('role="alert"');
    expect(render(response())).not.toContain("Provider 호출");
    const html = render(
      response({
        backlog: { open: 950, cap: 1000, warning: true },
        budget: { used: 2, maxCalls: 8, windowMs: 60_000, resetsAt: null },
      }),
    );
    expect(html).toContain('<p role="alert">끝나지 않은 작업이 950건');
    expect(html).toContain("최근 1분 동안 Provider 호출 2 / 8회");
  });

  it("says when a list is empty, and when only the latest jobs are shown", () => {
    const html = render(response({ truncated: true }));
    expect(html).toContain("작업이 없습니다.");
    expect(html).toContain("등록된 주기가 없습니다.");
    expect(html).toContain("최근 작업만 보입니다.");
  });
});
