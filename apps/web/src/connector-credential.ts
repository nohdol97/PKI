// A Connector's credential on the Sources screen (I06-R14, R17). In Electron the value goes straight to the
// shell's store through the preload under the name the list gave (the same path as the Provider's API key); the
// backend is told only that this instance's credential changed, never the value. The page never reads a value
// back and puts none into a request, an address, a result or a text. The browser has no shell, so it has no store.
import {
  CREDENTIAL_RETRY_MIN_MS,
  LOGIN_ERRORS,
  type LoginError,
  type RouteResponse,
} from "@pki/contracts";
import type { ApiClient } from "./api.ts";
import {
  deleteApiKey,
  saveApiKey,
  SECRET_REFUSAL_TEXT,
  type SecretAction,
  type SecretBridge,
  type SecretRefusal,
} from "./api-key.ts";
import { LOGIN_ERROR_TEXT } from "./connector-text.ts";

type Notice = RouteResponse<"credentialsChanged">;

/** What became of one action; none of it holds a value. */
export type CredentialOutcome =
  | { status: "store-unavailable" }
  | { status: "delete-failed" }
  | { status: "notify-failed" }
  | { status: "refused"; reason: SecretRefusal }
  | { status: "login-failed"; error: LoginError }
  | { status: "notified"; summary: Notice["summary"]; rebuild: Notice["rebuild"] };

/**
 * Stores or deletes in the shell under the listed name, and only when that succeeded tells the backend the
 * instance's credential changed. A failed store or delete gives no notice: nothing changed (I06-R14).
 */
export async function changeCredential(
  deps: { bridge: SecretBridge; api: ApiClient },
  connectorId: string,
  name: string,
  action: SecretAction,
): Promise<CredentialOutcome> {
  if (action.kind === "refused") return { status: "refused", reason: action.reason };
  let stored: boolean;
  if (action.kind === "save") {
    // a refused call of the preload (invalid input, wrong sender) is no store either
    const result = await saveApiKey(deps.bridge, name, action.value).catch(
      () => "unavailable" as const,
    );
    if (result === "line-break" || result === "too-long")
      return { status: "refused", reason: result };
    stored = result === "saved";
  } else {
    stored = await deleteApiKey(deps.bridge, name).catch(() => false);
  }
  if (!stored) return { status: action.kind === "save" ? "store-unavailable" : "delete-failed" };
  try {
    const { summary, rebuild } = await deps.api("credentialsChanged", { connectorId });
    return { status: "notified", summary, rebuild };
  } catch {
    return { status: "notify-failed" };
  }
}

/** The part of the Electron preload's `window.pki` the login button uses (I06S-R2). */
export interface LoginBridge {
  openLogin(connectorId: string): Promise<unknown>;
}

export function loginBridge(
  pki: unknown = (globalThis as { pki?: unknown }).pki,
): LoginBridge | undefined {
  const candidate = pki as Partial<LoginBridge> | undefined;
  return typeof candidate?.openLogin === "function" ? (candidate as LoginBridge) : undefined;
}

/**
 * Opens the instance's login window through the shell, which holds the description, stores the session and
 * answers `{ok}` without a value; the page hands it the instance ID and nothing else (I06S-R2). Only when it
 * succeeded is the backend told the instance's credential changed, the one notice every credential change
 * makes (I06S-R6). A failure, a rejected call or an answer of another shape gives no notice.
 */
export async function openLogin(
  deps: { bridge: LoginBridge; api: ApiClient },
  connectorId: string,
): Promise<CredentialOutcome> {
  const result = (await deps.bridge.openLogin(connectorId).catch(() => undefined)) as
    { ok?: unknown; error?: unknown } | null | undefined;
  if (result?.ok !== true) {
    const error = (LOGIN_ERRORS as readonly unknown[]).includes(result?.error)
      ? (result?.error as LoginError)
      : "invalid";
    return { status: "login-failed", error };
  }
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

export function credentialOutcomeText(outcome: CredentialOutcome): string {
  switch (outcome.status) {
    case "refused":
      return SECRET_REFUSAL_TEXT[outcome.reason];
    case "login-failed":
      return LOGIN_ERROR_TEXT[outcome.error];
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
