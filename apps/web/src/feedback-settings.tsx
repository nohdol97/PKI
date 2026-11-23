// The switch of the type step (P5F-R5): off until the user turns it on. Turning it on is a release step that
// waits for real-usage measurement (site-setup S36); this screen only carries the switch.
import { useEffect, useState } from "react";
import type { ApiClient } from "./api.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const FEEDBACK_LEARNED_TEXT =
  "같은 유형의 Insight에 준 피드백으로 순위를 조금 조정합니다. 기본은 꺼져 있습니다.";

export function FeedbackLearnedCheckbox({
  learned,
  onChange,
}: {
  learned: boolean;
  onChange: (learned: boolean) => void;
}) {
  return (
    <label>
      <input type="checkbox" checked={learned} onChange={(e) => onChange(e.target.checked)} />
      유형별 피드백 학습 사용
    </label>
  );
}

export function FeedbackLearnedSetting({ api }: { api: ApiClient }) {
  const [learned, setLearned] = useState<boolean>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    api("feedbackSettings").then(
      (r) => setLearned(r.learned),
      (e: unknown) => setFailure(message(e)),
    );
  }, [api]);
  const set = (next: boolean) =>
    api("setFeedbackSettings", { learned: next }).then(
      (r) => {
        setFailure(undefined);
        setLearned(r.learned);
      },
      (e: unknown) => setFailure(message(e)),
    );
  return (
    <>
      <h2>피드백 학습</h2>
      {failure && <p role="alert">불러오지 못했습니다: {failure}</p>}
      <p>{FEEDBACK_LEARNED_TEXT}</p>
      {learned !== undefined && (
        <FeedbackLearnedCheckbox learned={learned} onChange={(v) => void set(v)} />
      )}
    </>
  );
}
