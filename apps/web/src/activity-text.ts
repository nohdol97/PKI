// Words for the outcome column of the Activity screen's call history (I03-R14).
// The three outcomes of an attempt that did not end with an answer or an error get
// words; every other outcome is shown as its code, as before.
const OUTCOME: Readonly<Record<string, string>> = {
  started: "진행 중",
  interrupted: "중단됨",
  cancelled: "취소됨",
};

export function outcomeText(outcome: string): string {
  return OUTCOME[outcome] ?? outcome;
}
