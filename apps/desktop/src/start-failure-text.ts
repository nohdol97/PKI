// The dialog's words for a start that failed (I04-R7). Only a reason the backend
// reported as a fixed class gets its own text; anything else is the generic one.
import { BackendStartError } from "./backend-process.ts";

const GENERIC = "앱을 시작하지 못했습니다.";

export function startFailureText(error: unknown): string {
  return error instanceof BackendStartError && error.reason === "identity-key-missing"
    ? "이 데이터의 식별자 키가 없어 시작하지 않았습니다. 지운 자료가 다시 들어오지 못하게 하는 표식을 읽을 수 없어 가져오기와 동기화를 열지 않습니다. 키를 복원한 뒤 다시 시작하세요."
    : GENERIC;
}
