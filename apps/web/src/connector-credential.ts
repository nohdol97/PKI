// A Connector's credential on the Sources screen (I06-R14, R17). In Electron the value goes straight to the
// shell's store through the preload under the name the list gave (the same path as the Provider's API key); the
// backend is told only that this instance's credential changed, never the value. The page never reads a value
// back and puts none into a request, an address, a result or a text. The browser has no shell, so it has no store.
import { CREDENTIAL_RETRY_MIN_MS, type RouteResponse } from "@pki/contracts";
import type { ApiClient } from "./api.ts";
import { deleteApiKey, saveApiKey, type SecretBridge } from "./api-key.ts";

/** Why a value was refused before it reached the shell: it would have been changed or cut (I06-T04 decision, F3). */
export type CredentialRefusal = "line-break" | "too-long";

/** "refused" is the screen's own refusal of a paste; a save is checked again here. */
export type CredentialAction =
  | { kind: "save"; value: string }
  | { kind: "delete" }
  | { kind: "refused"; reason: CredentialRefusal };

/** The shell's limit (`SecretValueSchema`); a longer value is refused, never cut. */
export const MAX_CREDENTIAL_LENGTH = 8192;

/** A credential entered here is one line of at most `MAX_CREDENTIAL_LENGTH` characters. */
export function checkCredentialValue(value: string): CredentialRefusal | undefined {
  if (/[\r\n]/.test(value)) return "line-break";
  return value.length > MAX_CREDENTIAL_LENGTH ? "too-long" : undefined;
}

type Notice = RouteResponse<"credentialsChanged">;

/** What became of one action; none of it holds a value. */
export type CredentialOutcome =
  | { status: "store-unavailable" }
  | { status: "delete-failed" }
  | { status: "notify-failed" }
  | { status: "refused"; reason: CredentialRefusal }
  | { status: "notified"; summary: Notice["summary"]; rebuild: Notice["rebuild"] };

/**
 * Stores or deletes in the shell under the listed name, and only when that succeeded tells the backend the
 * instance's credential changed. A failed store or delete gives no notice: nothing changed (I06-R14).
 */
export async function changeCredential(
  deps: { bridge: SecretBridge; api: ApiClient },
  connectorId: string,
  name: string,
  action: CredentialAction,
): Promise<CredentialOutcome> {
  if (action.kind === "refused") return { status: "refused", reason: action.reason };
  if (action.kind === "save") {
    const reason = checkCredentialValue(action.value);
    if (reason) return { status: "refused", reason };
  }
  // a refused call of the preload (invalid input, wrong sender) is no store either
  const stored =
    action.kind === "save"
      ? await saveApiKey(deps.bridge, name, action.value).then(
          (r) => r === "saved",
          () => false,
        )
      : await deleteApiKey(deps.bridge, name).catch(() => false);
  if (!stored) return { status: action.kind === "save" ? "store-unavailable" : "delete-failed" };
  try {
    const { summary, rebuild } = await deps.api("credentialsChanged", { connectorId });
    return { status: "notified", summary, rebuild };
  } catch {
    return { status: "notify-failed" };
  }
}

const NOTICE_TEXT = {
  done: "반영했습니다.",
  queued: "곧 반영됩니다.",
  skipped: "앱을 다시 시작해야 반영됩니다.",
} as const satisfies Record<Notice["rebuild"], string>;

const REFUSAL_TEXT = {
  "line-break": "한 줄 값만 넣을 수 있습니다. 여러 줄 값(PEM, JSON)은 이 화면에서 받지 않습니다.",
  "too-long": `값이 너무 깁니다. ${MAX_CREDENTIAL_LENGTH}자까지 넣을 수 있고, 저장하지 않았습니다.`,
} as const satisfies Record<CredentialRefusal, string>;

export function credentialOutcomeText(outcome: CredentialOutcome): string {
  switch (outcome.status) {
    case "refused":
      return REFUSAL_TEXT[outcome.reason];
    case "store-unavailable":
      return "자격 증명을 저장할 수 없습니다 (OS 보호 저장소를 쓸 수 없음).";
    case "delete-failed":
      return "자격 증명을 지우지 못했습니다 (저장소 파일을 읽거나 쓸 수 없음).";
    case "notify-failed":
      return "자격 증명은 바뀌었지만 수집기에 알리지 못했습니다. 앱을 다시 시작하면 반영됩니다.";
    case "notified":
      return NOTICE_TEXT[outcome.rebuild];
  }
}

/**
 * When to read the list again after an action: at once, and for a queued rebuild once more after the gap of a
 * rejected instance, so a value fixed twice quickly does not leave the old "rejected" on screen (I06-R14).
 * A failed store or delete changed nothing, and a failed notice has nothing new to show.
 */
export function rereadDelaysMs(outcome: CredentialOutcome): number[] {
  if (outcome.status !== "notified") return [];
  return outcome.rebuild === "queued" ? [0, CREDENTIAL_RETRY_MIN_MS] : [0];
}
