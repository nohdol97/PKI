// Words for the Providers in Settings (V01-R5, R9), in one place: their names, what
// "Provider 확인" found, and how to install a CLI or log in to it. The addresses are
// the vendor documents the CLI research cites (docs/research, sections 3 and 4).
import type { ProviderCheck, ProviderId } from "@pki/contracts";

const NAME: Readonly<Record<ProviderId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  "openai-compatible": "OpenAI 호환 API",
  "local-model": "로컬 모델",
};

const INSTALL: Partial<Record<ProviderId, string>> = {
  "claude-code":
    "설치: https://code.claude.com/docs/en/ 의 안내대로 Claude Code를 설치한 뒤, 터미널에서 `claude`를 실행해 로그인하세요.",
  codex:
    "설치: https://developers.openai.com/codex/ 의 안내대로 Codex CLI를 설치한 뒤, 터미널에서 `codex login`으로 로그인하세요.",
};

const LOGIN: Partial<Record<ProviderId, string>> = {
  "claude-code":
    "로그인: 터미널에서 `claude`를 실행하고 안내에 따라 로그인하세요(https://code.claude.com/docs/en/authentication).",
  codex: "로그인: 터미널에서 `codex login`을 실행하세요(https://developers.openai.com/codex/auth).",
};

const AUTH = {
  authenticated: "로그인됨",
  unauthenticated: "로그인되어 있지 않음",
  unknown: "로그인 상태를 알 수 없음",
} as const;

/** An HTTP Provider has nothing to install: "installed" means an endpoint is set (T11). */
const HTTP: ReadonlySet<ProviderId> = new Set(["openai-compatible", "local-model"]);

export function providerName(id: ProviderId): string {
  return NAME[id];
}

/** What a check found, and the guidance to show with it (null when nothing is missing). */
export function providerCheckText(check: ProviderCheck): {
  state: string;
  guidance: string | null;
} {
  if (HTTP.has(check.providerId)) {
    if (!check.installed) return { state: "주소가 설정되지 않음", guidance: null };
    return {
      state: check.authentication === "unauthenticated" ? "API 키 없음" : "주소 설정됨",
      guidance: null,
    };
  }
  if (!check.installed) {
    return { state: "설치되어 있지 않음", guidance: INSTALL[check.providerId] ?? null };
  }
  const version = check.version ?? "버전을 읽지 못함";
  return {
    state: `설치됨(${version}), ${AUTH[check.authentication]}`,
    guidance: check.authentication === "authenticated" ? null : (LOGIN[check.providerId] ?? null),
  };
}
