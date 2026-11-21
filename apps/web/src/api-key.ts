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

/** "saved", or "unavailable" when the shell could not store it (no OS protection). */
export async function saveApiKey(
  bridge: SecretBridge,
  keyName: string,
  value: string,
): Promise<"saved" | "unavailable"> {
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
