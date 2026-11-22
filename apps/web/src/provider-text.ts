// Words for the Providers in Settings (V01-R5, R9), in one place: their names, what
// "Provider 확인" found, and how to install a CLI or log in to it. The addresses are
// the vendor documents the CLI research cites (docs/research, sections 3 and 4).
import type { ConnectionTestResult, ProviderCheck, ProviderId } from "@pki/contracts";

const NAME: Readonly<Record<ProviderId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  "openai-compatible": "OpenAI 호환 API",
  "local-model": "로컬 모델",
};

/** The product runs no shell, so on Windows it finds `<name>.exe` only (V01-T10, unverified). */
const WINDOWS_NOTE =
  " Windows에서는 실행 파일(.exe)로 설치된 CLI만 찾습니다. npm으로 설치해 생기는 .cmd 실행 파일은 지원하지 않습니다(미검증).";

const INSTALL: Partial<Record<ProviderId, string>> = {
  "claude-code":
    "설치: https://code.claude.com/docs/en/ 의 안내대로 Claude Code를 설치한 뒤, 터미널에서 `claude`를 실행해 로그인하세요." +
    WINDOWS_NOTE,
  codex:
    "설치: https://developers.openai.com/codex/ 의 안내대로 Codex CLI를 설치한 뒤, 터미널에서 `codex login`으로 로그인하세요." +
    WINDOWS_NOTE,
};

const LOGIN: Partial<Record<ProviderId, string>> = {
  "claude-code":
    "로그인: 터미널에서 `claude`를 실행하고 안내에 따라 로그인하세요(https://code.claude.com/docs/en/authentication).",
  codex: "로그인: 터미널에서 `codex login`을 실행하세요(https://developers.openai.com/codex/auth).",
};

/** The run folder root failed its check (V01-T10): only the user can fix it, safely. */
const RUNS_ROOT =
  "데이터 폴더 안의 cli-runs 폴더가 이 사용자만 쓸 수 있는 폴더(권한 0700)가 아니거나 링크여서 CLI를 실행하지 않습니다. 앱을 끄고 그 폴더를 지우면 다음 실행 때 0700으로 다시 만듭니다.";

const AUTH = {
  authenticated: "로그인됨",
  unauthenticated: "로그인되어 있지 않음",
  unknown: "로그인 상태를 확인할 수 없음",
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
  if (check.problem === "cli-runs-root-refused")
    return { state: "실행 폴더를 쓸 수 없음", guidance: RUNS_ROOT };
  if (!check.installed) {
    return { state: "설치되어 있지 않음", guidance: INSTALL[check.providerId] ?? null };
  }
  const version = check.version ?? "버전을 읽지 못함";
  return {
    state: `설치됨(${version}), ${AUTH[check.authentication]}`,
    guidance: check.authentication === "authenticated" ? null : (LOGIN[check.providerId] ?? null),
  };
}

/** The guidance a connection test result carries (its default CLI missing or logged out), or none. */
export function connectionTestGuidance(result: ConnectionTestResult): string | null {
  if (!result.providerCheck) return null;
  const { state, guidance } = providerCheckText(result.providerCheck);
  const line = `${providerName(result.providerCheck.providerId)}: ${state}`;
  return guidance ? `${line}. ${guidance}` : line;
}
