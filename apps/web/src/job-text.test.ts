// I03-R23: the Activity screen's words for jobs. Every code gets a fixed Korean text; a code
// the screen does not know is shown as itself (it is a code, never a message), and an
// imported or Provider text has no way in.
import { describe, expect, it } from "vitest";
import {
  CancelJobResponseSchema,
  DiscardJobResponseSchema,
  JobStatusSchema,
  RebuildProjectionResponseSchema,
  RetryJobResponseSchema,
  RunScheduleResponseSchema,
  ScheduleActionResponseSchema,
  SYNC_STOP_CODES,
} from "@pki/contracts";
import { DELETIONS_MAY_BE_MISSED, syncStopText } from "./connector-text.ts";
import {
  actionText,
  discardStep,
  runAction,
  budgetText,
  invalidationText,
  jobNote,
  kindText,
  periodText,
  projectionText,
  reasonText,
  resultCountsText,
  scheduleStateText,
  statusText,
} from "./job-text.ts";

describe("reasonText", () => {
  it("gives a code its meaning with the code beside it, and an unknown code as itself", () => {
    expect(reasonText("no-consent")).toBe("Provider 전송 동의가 없음 (no-consent)");
    expect(reasonText("some-new-code")).toBe("some-new-code");
  });

  it("words every sync stop code with the sentence the Sources screen already uses (I01-T03), not a copy", () => {
    for (const code of SYNC_STOP_CODES) {
      expect(reasonText(code)).toBe(`${syncStopText(code)} (${code})`);
    }
  });

  it("tells a removal skipped because its adapter is permanently absent from one retrying because the projection is unavailable (I04-T04)", () => {
    const skipped = reasonText("adapter-unavailable");
    const retrying = reasonText("projection-unavailable");
    expect(skipped).not.toBe(retrying);
    expect(skipped).toContain("건너뜀");
    expect(retrying).toContain("다시 시도");
  });

  it("words the three collector holds and the manager that was not ready (I03-T09)", () => {
    for (const code of ["unsupported-sdk-version", "connector-unavailable", "not-implemented"]) {
      expect(reasonText(code)).toMatch(/수집기|Connector/);
    }
    expect(reasonText("manager-not-ready")).toContain("준비");
  });

  it("words the kind mismatch hold apart from the plain one (I05F-R7)", () => {
    expect(reasonText("instance-kind-mismatch")).not.toBe("instance-kind-mismatch");
    expect(reasonText("instance-kind-mismatch")).not.toBe(reasonText("connector-unavailable"));
  });

  it("words the four credential holds apart from each other and from the plain one (I06-R10)", () => {
    const codes = [
      "credential-store-unavailable",
      "credential-missing",
      "credential-unreadable",
      "credential-rejected",
    ];
    const texts = codes.map(reasonText);
    expect(new Set([...texts, reasonText("connector-unavailable")]).size).toBe(5);
    for (const text of texts) expect(text).toMatch(/자격 증명/);
    // the session instance's hold has its own words (I06S-R10)
    expect(texts).not.toContain(reasonText("login-required"));
    expect(reasonText("login-required")).toContain("로그인");
  });

  it("never turns text into a sentence: a string that is not a code shape comes back unchanged and the screen renders it as text", () => {
    expect(reasonText("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("words for kinds, statuses, periods", () => {
  it("words the kinds and statuses, and an unknown kind as its code", () => {
    expect(kindText("connector-sync")).toBe("동기화");
    expect(kindText("projection-rebuild")).toBe("투영 재구축");
    expect(kindText("wiki-build")).toBe("위키 만들기");
    expect(kindText("future-kind")).toBe("future-kind");
    expect(statusText("dead_letter")).toBe("포기");
    expect(statusText("held")).toBe("보류");
  });

  it("words the four periods", () => {
    expect(periodText({ kind: "every-10-minutes" })).toBe("10분마다");
    expect(periodText({ kind: "hourly" })).toBe("1시간마다");
    expect(periodText({ kind: "daily", at: { hour: 3, minute: 0 } })).toBe("매일 03:00");
    expect(periodText({ kind: "weekly", weekday: 1, at: { hour: 2, minute: 30 } })).toBe(
      "매주 월요일 02:30",
    );
  });

  it("words a pause by why: a given-up job or a held one with its reason", () => {
    expect(scheduleStateText({ enabled: false })).toBe("꺼짐");
    expect(scheduleStateText({ enabled: true })).toBe("켜짐");
    expect(
      scheduleStateText({ enabled: true, pause: { kind: "failed", code: "handler-error" } }),
    ).toContain("멈춤(포기");
    expect(
      scheduleStateText({ enabled: true, pause: { kind: "held", reason: "no-consent" } }),
    ).toContain("멈춤(보류: Provider 전송 동의가 없음");
  });
});

describe("result counts (I01-R19, I03-T09)", () => {
  it("shows a sync's stale-tombstone and blocked counts and the rescan marks, with I01's sentence for missed deletions", () => {
    const text = resultCountsText("connector-sync", {
      received: 5,
      staleTombstone: 2,
      blocked: 1,
      rescanned: 1,
      deletionsMayBeMissed: 1,
    });
    expect(text).toContain("지연된 삭제(적용 안 됨) 2건");
    expect(text).toContain("막힘 1건");
    expect(text).toContain("다시 훑음");
    expect(text).toContain(DELETIONS_MAY_BE_MISSED);
  });

  it("does not show the missed-deletions sentence when the mark is 0 or absent", () => {
    expect(
      resultCountsText("connector-sync", { received: 1, rescanned: 1, deletionsMayBeMissed: 0 }),
    ).not.toContain(DELETIONS_MAY_BE_MISSED);
    expect(resultCountsText("connector-sync", { received: 1 })).not.toContain("다시 훑음");
  });

  it("reads a cleanup's purged count and says nothing of a kind that holds none", () => {
    expect(resultCountsText("maintenance", { purged: 4 })).toContain("정리한 기록 4건");
    expect(resultCountsText("extract", null)).toBe("");
  });
});

describe("notes, projections, budget, actions", () => {
  it("marks a version whose re-extraction was dropped by lineage as not extracted (I04-T06, I03-T07 10)", () => {
    expect(
      jobNote({
        kind: "extract",
        status: "superseded",
        reason: "lineage-covered",
        target: "lineage-retry:12",
      }),
    ).toBe("추출되지 않은 version");
    // the first extraction dropped by lineage has a re-extraction registered: no note
    expect(
      jobNote({ kind: "extract", status: "superseded", reason: "lineage-covered", target: "" }),
    ).toBeUndefined();
    expect(
      jobNote({
        kind: "extract",
        status: "succeeded",
        reason: "lineage-covered",
        target: "lineage-retry:12",
      }),
    ).toBeUndefined();
  });

  it("words a projection's rebuild state and its removals", () => {
    expect(
      projectionText({ name: "engine", openRemoves: 0, deadRemoves: 0, rebuild: "pending" }),
    ).toContain("재구축 대기");
    expect(
      projectionText({ name: "engine", openRemoves: 1, deadRemoves: 2, rebuild: "repeating" }),
    ).toContain("재구축 반복 중(투영 사용 불가)");
  });

  it("words the budget as the calls used of the window's maximum", () => {
    expect(budgetText({ used: 3, maxCalls: 10, windowMs: 60_000, resetsAt: null })).toBe(
      "최근 1분 동안 Provider 호출 3 / 10회",
    );
    expect(
      budgetText({
        used: 10,
        maxCalls: 10,
        windowMs: 3_600_000,
        resetsAt: "2026-11-21T00:30:00.000Z",
      }),
    ).toContain("다음 빈 자리 2026-11-21T00:30:00.000Z");
  });

  it("words every outcome the contract can answer, for every action, and never shows a bare code", () => {
    const options = {
      cancel: CancelJobResponseSchema.shape.outcome.options,
      retry: RetryJobResponseSchema.shape.outcome.options,
      discard: DiscardJobResponseSchema.shape.outcome.options,
      runSchedule: RunScheduleResponseSchema.shape.outcome.options,
      rebuild: RebuildProjectionResponseSchema.shape.outcome.options,
      schedule: ScheduleActionResponseSchema.shape.outcome.options,
    } as const;
    for (const [kind, outcomes] of Object.entries(options)) {
      for (const outcome of outcomes) {
        const text = actionText(kind as keyof typeof options, outcome);
        expect([kind, outcome, text !== outcome]).toEqual([kind, outcome, true]);
      }
    }
    expect(actionText("cancel", "requested")).toContain("취소를 요청");
    expect(actionText("cancel", "not-found")).toContain("30일");
    expect(actionText("discard", "unavailable")).toContain("사용할 수 없");
  });

  it("words a status for every status the contract has", () => {
    for (const status of JobStatusSchema.options) expect(statusText(status)).not.toBe(status);
  });
});

describe("runAction (what an action leaves on the screen)", () => {
  it("says the outcome, including a job that is gone and a feature that is unavailable", async () => {
    expect(await runAction("cancel", async () => ({ outcome: "not-found" }))).toEqual({
      text: actionText("cancel", "not-found"),
      failed: false,
    });
    expect(await runAction("discard", async () => ({ outcome: "unavailable" }))).toEqual({
      text: "지금은 사용할 수 없습니다.",
      failed: false,
    });
  });

  it("words a failed request as a failed action, not as a load failure, with the error's code", async () => {
    const result = await runAction("retry", () =>
      Promise.reject(new Error("API 500: internal-error")),
    );
    expect(result).toEqual({ text: "실행하지 못했습니다: API 500: internal-error", failed: true });
    expect(result.text).not.toContain("불러오지");
  });
});

describe("discardStep (the question before a discard)", () => {
  it("sends nothing when asked, nothing when cancelled, and only the asked job on confirmation", () => {
    expect(discardStep(undefined, { type: "ask", id: 7 })).toEqual({ next: 7 });
    expect(discardStep(7, { type: "cancel" })).toEqual({ next: undefined });
    expect(discardStep(7, { type: "confirm" })).toEqual({ next: undefined, send: 7 });
    // a confirmation with nothing asked sends nothing
    expect(discardStep(undefined, { type: "confirm" })).toEqual({ next: undefined });
    // asking about another job replaces the question: the confirmation is for the latest
    expect(
      discardStep(discardStep(undefined, { type: "ask", id: 7 }).next, { type: "ask", id: 9 }),
    ).toEqual({
      next: 9,
    });
  });
});

describe("invalidationText (I04-R4)", () => {
  it("counts the recent records and the items the scope policy dropped", () => {
    expect(invalidationText({ recent: [1, 2, 3], scopePolicyDrops: 0 })).toBe(
      "최근 무효화 기록 3건, 범위 정책으로 빠진 항목 0건",
    );
    expect(invalidationText({ recent: [], scopePolicyDrops: 4 })).toBe(
      "최근 무효화 기록 0건, 범위 정책으로 빠진 항목 4건",
    );
  });
});

describe("a re-extraction a scope change registered (I04-R15)", () => {
  it("is noted on an extract job with a scope-recompute target, and on no other job", () => {
    const note = jobNote({
      kind: "extract",
      status: "queued",
      reason: null,
      target: "scope-recompute:5",
    });
    expect(note).toBe("범위가 바뀌어 다시 추출하는 작업");
    expect(
      jobNote({ kind: "extract", status: "queued", reason: null, target: "" }),
    ).toBeUndefined();
    expect(
      jobNote({ kind: "maintenance", status: "queued", reason: null, target: "scope-recompute:5" }),
    ).toBeUndefined();
  });
});
