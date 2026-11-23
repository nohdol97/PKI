// The 알림 screen (P02-R15, R16): one answer of the backend shown three ways — the feed (what to look at now),
// the digests (the daily summary and the weekly report, their content computed when opened) and the timeline (every
// line by date, with how it was told and why). A card is the Insight's own view (a 추론 mark, the type, the fact
// lines, the reason and the ranking), the evidence in the source view the other screens use, and the four actions.
// The Insight's words are imported or rule-made text: they reach the page as React text nodes inside <bdi> only
// (V02-R15). The screen reads again when `refresh` changes (`useChanges`); a line, an Insight or a source that went
// away shows its plain sentence instead of staying on screen.
import type { NotificationLine, RouteRequest, RouteResponse } from "@pki/contracts";
import { useEffect, useReducer, useState } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import { countsText, ruleText } from "./lint-text.ts";
import { EvidencePanel, evidenceReducer, InsightSummary } from "./evidence-view.tsx";
import {
  DIGEST_EMPTY,
  DIGEST_KIND,
  DIGEST_LINES_EMPTY,
  FEED_ALWAYS,
  FEED_EMPTY,
  NOTIFICATIONS_NOT_FACT,
  SNOOZES,
  TABS,
  TIMELINE_EMPTY,
  dateText,
  reasonText,
  timeText,
  wayText,
  type Tab,
} from "./notifications-text.ts";

type List = RouteResponse<"notifications">;
type Digest = NonNullable<RouteResponse<"notificationDigest">["digest"]>;
type Row = List["digests"][number];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const gone = (error: unknown) => error instanceof ApiError && error.status === 404;

export function Notifications({ api, refresh }: { api: ApiClient; refresh: string }) {
  const [list, setList] = useState<List>();
  const [failure, setFailure] = useState<string>();
  const [tab, setTab] = useState<Tab>("feed");
  const [mine, setMine] = useState(0);
  const [digestId, setDigestId] = useState<number>();
  const [digest, setDigest] = useState<Digest>();
  const [evidence, dispatch] = useReducer(evidenceReducer, { opens: 0 });
  const { opened } = evidence;
  const openedId = opened?.insightId;

  useEffect(() => {
    api("notifications").then(
      (r) => (setFailure(undefined), setList(r)),
      (e: unknown) => setFailure(message(e)),
    );
  }, [api, refresh, mine]);
  // the open evidence and the open digest are read again on a change; what is gone shows its sentence
  useEffect(() => {
    if (openedId === undefined) return;
    api("insightEvidence", { insightId: openedId }).then(
      (r) => dispatch({ type: "evidence-refreshed", insightId: openedId, evidence: r.evidence }),
      (error: unknown) => dispatch({ type: "failed", what: "insight", id: openedId, error }),
    );
  }, [api, refresh]);
  useEffect(() => {
    if (digestId === undefined) return;
    api("notificationDigest", { id: digestId }).then(
      (r) => setDigest(r.digest ?? undefined),
      (e: unknown) => setFailure(message(e)),
    );
  }, [api, digestId, refresh, mine]);

  const act = (request: RouteRequest<"notificationAct">) =>
    api("notificationAct", request).then(
      () => setMine((n) => n + 1),
      (e: unknown) => (gone(e) ? setMine((n) => n + 1) : setFailure(message(e))),
    );
  const openEvidence = (insightId: number) =>
    api("insightEvidence", { insightId }).then(
      (r) => dispatch({ type: "insight-opened", insightId, evidence: r.evidence }),
      (error: unknown) => dispatch({ type: "failed", what: "insight", id: insightId, error }),
    );
  const openSource = (evidenceId: number) =>
    api("evidenceSource", { evidenceId }).then(
      (s) => dispatch({ type: "source-opened", source: s }),
      (error: unknown) => dispatch({ type: "failed", what: "source", id: evidenceId, error }),
    );

  const feed = list?.lines.filter((l) => l.status === "sent") ?? [];
  return (
    <>
      <p>{NOTIFICATIONS_NOT_FACT}</p>
      {failure && <p role="alert">불러오지 못했습니다: {failure}</p>}
      <div role="group" aria-label="알림 보기">
        {(Object.keys(TABS) as Tab[]).map((id) => (
          <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>
            {TABS[id]}
          </button>
        ))}
      </div>
      {tab === "feed" && list && (
        <>
          {feed.length === 0 && <p>{FEED_EMPTY}</p>}
          {feed.length > 0 && (
            <ul aria-label="알림 피드">
              {feed.map((line) => (
                <li key={line.id}>
                  <Card line={line} onAct={act} onOpenEvidence={openEvidence} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {tab === "digest" && list && (
        <Digests
          rows={list.digests}
          open={digestId}
          digest={digest}
          onOpen={(id) => (setDigest(undefined), setDigestId(id))}
          onAct={act}
        />
      )}
      {tab === "timeline" && list && <Timeline lines={list.lines} onOpenEvidence={openEvidence} />}
      {evidence.notice && <p role="alert">{evidence.notice}</p>}
      <EvidencePanel state={evidence} onOpenSource={openSource} />
      <Settings api={api} />
    </>
  );
}

function Card({
  line,
  onAct,
  onOpenEvidence,
}: {
  line: NotificationLine;
  onAct: (request: RouteRequest<"notificationAct">) => void;
  onOpenEvidence: (insightId: number) => void;
}) {
  const name = line.insight.summary;
  return (
    <>
      <InsightSummary insight={line.insight} />
      {line.reason !== null && <p>{reasonText(line.reason)}</p>}
      {line.readAt === null && line.status === "sent" && <p>읽지 않음</p>}
      {line.actions.includes("evidence") && (
        <button type="button" onClick={() => onOpenEvidence(line.insight.id)}>
          근거 보기 ({line.insight.evidenceCount})
        </button>
      )}
      {line.actions.includes("read") && (
        <button
          type="button"
          aria-label={`읽음: ${name}`}
          onClick={() => onAct({ id: line.id, op: "read" })}
        >
          읽음으로 표시
        </button>
      )}
      {line.actions.includes("snooze") &&
        SNOOZES.map(({ minutes, label }) => (
          <button
            key={minutes}
            type="button"
            aria-label={`다시 알림 ${label}: ${name}`}
            onClick={() => onAct({ id: line.id, op: "snooze", minutes })}
          >
            {label} 뒤 다시 알림
          </button>
        ))}
      {line.actions.includes("unsnooze") && (
        <button
          type="button"
          aria-label={`다시 알림 취소: ${name}`}
          onClick={() => onAct({ id: line.id, op: "unsnooze" })}
        >
          다시 알림 취소
        </button>
      )}
      {line.actions.includes("dismiss") && (
        <button
          type="button"
          aria-label={`닫기: ${name}`}
          onClick={() => onAct({ id: line.id, op: "dismiss" })}
        >
          닫기
        </button>
      )}
    </>
  );
}

function Digests({
  rows,
  open,
  digest,
  onOpen,
  onAct,
}: {
  rows: readonly Row[];
  open: number | undefined;
  digest: Digest | undefined;
  onOpen: (id: number) => void;
  onAct: (request: RouteRequest<"notificationAct">) => void;
}) {
  if (rows.length === 0) return <p>{DIGEST_EMPTY}</p>;
  return (
    <>
      <ul aria-label="요약 목록">
        {rows.map((row) => (
          <li key={row.id}>
            <strong>{DIGEST_KIND[row.kind]}</strong> {dateText(row.windowStart)} ~{" "}
            {dateText(row.windowEnd)} · {row.count}건 {row.readAt === null && "· 읽지 않음"}
            <button
              type="button"
              aria-label={`내용 보기: ${DIGEST_KIND[row.kind]} ${dateText(row.windowEnd)}`}
              onClick={() => onOpen(row.id)}
            >
              내용 보기
            </button>
            {row.readAt === null && (
              <button
                type="button"
                aria-label={`읽음: ${DIGEST_KIND[row.kind]} ${dateText(row.windowEnd)}`}
                onClick={() => onAct({ id: row.id, op: "read" })}
              >
                읽음으로 표시
              </button>
            )}
            <button
              type="button"
              aria-label={`닫기: ${DIGEST_KIND[row.kind]} ${dateText(row.windowEnd)}`}
              onClick={() => onAct({ id: row.id, op: "dismiss" })}
            >
              닫기
            </button>
          </li>
        ))}
      </ul>
      {open !== undefined && digest && (
        <section aria-label="요약 내용 보기">
          <h3>
            {DIGEST_KIND[digest.kind]} · {dateText(digest.windowStart)} ~{" "}
            {dateText(digest.windowEnd)}
          </h3>
          {digest.lines.length === 0 && <p>{DIGEST_LINES_EMPTY}</p>}
          {digest.lines.length > 0 && (
            <ul aria-label="요약 내용">
              {digest.lines.map((line) => (
                <li key={line.id}>
                  <InsightSummary insight={line.insight} />
                  <p>{wayText(line)}</p>
                </li>
              ))}
            </ul>
          )}
          {digest.lint && (
            <>
              <p>구간 안에 새로 열린 점검 발견 {digest.lint.opened}건</p>
              <ul aria-label="점검 규칙별 수">
                {digest.lint.counts.map((c) => (
                  <li key={c.rule}>
                    {ruleText(c.rule)}: {countsText(c)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}

function Timeline({
  lines,
  onOpenEvidence,
}: {
  lines: readonly NotificationLine[];
  onOpenEvidence: (insightId: number) => void;
}) {
  if (lines.length === 0) return <p>{TIMELINE_EMPTY}</p>;
  const days = new Map<string, NotificationLine[]>();
  for (const line of lines) {
    const day = dateText(line.createdAt);
    days.set(day, [...(days.get(day) ?? []), line]);
  }
  return (
    <>
      {[...days].map(([day, dayLines]) => (
        <section key={day}>
          <h3>{day}</h3>
          <ul aria-label={`알림 타임라인 ${day}`}>
            {dayLines.map((line) => (
              <li key={line.id}>
                <p>
                  <bdi>{line.insight.summary}</bdi>
                </p>
                <p>
                  {timeText(line.createdAt)} · {wayText(line)}
                </p>
                {line.actions.includes("evidence") && (
                  <button type="button" onClick={() => onOpenEvidence(line.insight.id)}>
                    근거 보기 ({line.insight.evidenceCount})
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** OS notification, quiet hours and a pause of everything (P02-R6, R10): the feed fills whatever these say. */
function Settings({ api }: { api: ApiClient }) {
  const [settings, setSettings] = useState<RouteResponse<"notificationSettings">>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    api("notificationSettings").then(setSettings, (e: unknown) => setFailure(message(e)));
  }, [api]);
  const write = (patch: RouteRequest<"setNotificationSettings">) =>
    api("setNotificationSettings", patch).then(
      (next) => (setFailure(undefined), setSettings(next)),
      (e: unknown) => setFailure(message(e)),
    );
  const paused = settings?.snoozeUntil != null && Date.parse(settings.snoozeUntil) > Date.now();
  return (
    <details>
      <summary>알림 설정</summary>
      {failure && <p role="alert">저장하지 못했습니다: {failure}</p>}
      {settings && (
        <>
          <label>
            <input
              type="checkbox"
              checked={settings.os}
              onChange={(e) => void write({ os: e.target.checked })}
            />
            OS 알림 사용 (건수만 표시됩니다)
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.quietHours.enabled}
              onChange={(e) =>
                void write({ quietHours: { ...settings.quietHours, enabled: e.target.checked } })
              }
            />
            조용한 시간에는 OS 알림 보류
          </label>
          <label>
            시작
            <input
              type="time"
              value={settings.quietHours.start}
              onChange={(e) =>
                e.target.value &&
                void write({ quietHours: { ...settings.quietHours, start: e.target.value } })
              }
            />
          </label>
          <label>
            끝
            <input
              type="time"
              value={settings.quietHours.end}
              onChange={(e) =>
                e.target.value &&
                void write({ quietHours: { ...settings.quietHours, end: e.target.value } })
              }
            />
          </label>
          {paused && settings.snoozeUntil !== null ? (
            <>
              <p>모든 OS 알림을 {timeText(settings.snoozeUntil)}까지 보류하는 중입니다.</p>
              <button type="button" onClick={() => void write({ snoozeUntil: null })}>
                일시 중지 해제
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() =>
                void write({ snoozeUntil: new Date(Date.now() + 3_600_000).toISOString() })
              }
            >
              1시간 동안 OS 알림 일시 중지
            </button>
          )}
          <p>{FEED_ALWAYS}</p>
        </>
      )}
    </details>
  );
}
