// The API key on the Settings screen (V01-R11, R13; review A-F3/B-B1). In Electron the
// key goes straight to the shell's store through the preload under the name the
// backend gives for the endpoint's host (`keyName`): the page never reads it back, and
// a key entered for one host is never sent to another. The browser has no shell, so
// development gives the key through environment variables instead.
import type { RouteResponse } from "@pki/contracts";

/** The part of the Electron preload's `window.pki` the key entry uses. */
export interface SecretBridge {
  setSecret(name: string, value: string): Promise<unknown>;
  deleteSecret(name: string): Promise<unknown>;
}

export function secretBridge(
  pki: unknown = (globalThis as { pki?: unknown }).pki,
): SecretBridge | undefined {
  const candidate = pki as Partial<SecretBridge> | undefined;
  return typeof candidate?.setSecret === "function" && typeof candidate.deleteSecret === "function"
    ? (candidate as SecretBridge)
    : undefined;
}

const isOk = (result: unknown) => (result as { ok?: unknown } | null)?.ok === true;

/** Why a value was refused before it reached the shell: it would have been changed or cut (I06-T04 decision, F3). */
export type SecretRefusal = "line-break" | "too-long";

/** What a secret input hands over: a value to store, a delete, or an insertion the field itself refused. */
export type SecretAction =
  { kind: "save"; value: string } | { kind: "delete" } | { kind: "refused"; reason: SecretRefusal };

/** The shell's limit (`SecretValueSchema`), in UTF-16 code units; a longer value is refused, never cut. */
export const MAX_SECRET_LENGTH = 8192;

/** A secret entered on a screen is one line of at most `MAX_SECRET_LENGTH` characters. */
export function checkSecretValue(value: string): SecretRefusal | undefined {
  if (/[\r\n]/.test(value)) return "line-break";
  return value.length > MAX_SECRET_LENGTH ? "too-long" : undefined;
}

export const SECRET_REFUSAL_TEXT = {
  "line-break": "한 줄 값만 넣을 수 있습니다. 여러 줄 값(PEM, JSON)은 이 화면에서 받지 않습니다.",
  "too-long": `값이 너무 깁니다. ${MAX_SECRET_LENGTH}자까지 넣을 수 있고, 저장하지 않았습니다.`,
} as const satisfies Record<SecretRefusal, string>;

/**
 * "saved", "unavailable" when the shell could not store it (no OS protection), or the refusal of the value
 * itself: checked here, in the one function that asks the shell, so no screen can skip it (I06F-R5).
 */
export async function saveApiKey(
  bridge: SecretBridge,
  keyName: string,
  value: string,
): Promise<"saved" | "unavailable" | SecretRefusal> {
  const refusal = checkSecretValue(value);
  if (refusal) return refusal;
  return isOk(await bridge.setSecret(keyName, value)) ? "saved" : "unavailable";
}

export async function deleteApiKey(bridge: SecretBridge, keyName: string): Promise<boolean> {
  return isOk(await bridge.deleteSecret(keyName));
}

type OpenAISettings = RouteResponse<"settings">["openaiCompatible"];

export function keyStatusText({ host, key }: OpenAISettings): string {
  if (host === null || key === null) return "주소를 먼저 저장하세요";
  if (key === "present") return `저장됨 (${host}에만 보냄)`;
  if (key === "missing") return `없음 — ${host}에 쓸 키를 입력하세요`;
  return "사용할 수 없음 (OS 보호 저장소를 쓸 수 없음)";
}

/** Where browser development takes the key from (backend/src/secret-sources.ts). */
export const DEV_KEY_HINT =
  "브라우저 개발 환경에는 키 저장소가 없습니다. 백엔드를 띄울 때 PKI_DEV_OPENAI_API_KEY_HOST(주소의 호스트)와 PKI_DEV_OPENAI_API_KEY 환경 변수로 줍니다.";
