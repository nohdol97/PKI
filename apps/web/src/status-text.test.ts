// V01-R5, R14: Home states what each part can do, in words; for embedding also
// whether texts leave the machine (a remote embedder is shown as external egress).
import { describe, expect, it } from "vitest";
import {
  componentText,
  DOWNLOAD_APPROVAL,
  embeddingText,
  providerStatusText,
  vectorIndexText,
} from "./status-text.ts";

describe("componentText", () => {
  it.each([
    [{ state: "ready" }, "준비됨"],
    [{ state: "rebuilding" }, "재구성 중"],
    [{ state: "not-implemented" }, "미구현"],
    [{ state: "unavailable", reason: "no module" }, "사용 불가: no module"],
  ] as const)("%o → %s", (status, text) => {
    expect(componentText(status)).toBe(text);
  });
});

describe("embeddingText", () => {
  it.each([
    [{ state: "ready", egress: "local" }, "준비됨 (로컬 계산)"],
    [{ state: "preparing", egress: "local" }, "준비 중 (로컬 계산)"],
    [{ state: "model-missing", egress: "local" }, "모델 없음, 키워드 검색으로 동작 (로컬 계산)"],
    [{ state: "ready", egress: "external" }, "준비됨 (외부 전송)"],
    [
      { state: "unavailable", reason: "runtime failed", egress: "local" },
      "사용 불가: runtime failed, 키워드 검색으로 동작 (로컬 계산)",
    ],
    [
      { state: "unavailable", reason: "model download failed", egress: "local" },
      "사용 불가: 모델을 내려받지 못함(네트워크·프록시 확인), 키워드 검색으로 동작 (로컬 계산)",
    ],
    [
      { state: "unavailable", reason: "model file missing", egress: "local" },
      "사용 불가: 모델 파일이 없음, 키워드 검색으로 동작 (로컬 계산)",
    ],
    [
      { state: "unavailable", reason: "status check failed" },
      "사용 불가: 상태를 읽지 못함, 키워드 검색으로 동작",
    ],
    [{ state: "not-implemented" }, "미구현"],
  ] as const)("%o → %s", (status, text) => {
    expect(embeddingText(status)).toBe(text);
  });
});

describe("vectorIndexText (V01-R5, R15)", () => {
  it("says the build has no index and that keyword search still works", () => {
    expect(
      vectorIndexText({ state: "unavailable", reason: "no vector index module in this build" }),
    ).toBe("사용 불가: 이 빌드에는 벡터 색인이 없음, 키워드 검색으로 동작");
    expect(vectorIndexText({ state: "unavailable", reason: "other" })).toBe(
      "사용 불가: other, 키워드 검색으로 동작",
    );
    expect(vectorIndexText({ state: "ready" })).toBe("준비됨");
  });
});

describe("providerStatusText (V01-R5, T16)", () => {
  it("names the default and that it can be used", () => {
    expect(providerStatusText({ state: "ready", providerId: "codex" })).toEqual({
      text: "Codex CLI: 사용 가능",
      guidance: null,
    });
  });

  it("says no default is chosen, and where to choose one", () => {
    expect(
      providerStatusText({ state: "unavailable", providerId: null, reason: "no-provider" }),
    ).toEqual({
      text: "기본 Provider가 정해지지 않음. 설정 화면에서 고르세요.",
      guidance: null,
    });
  });

  it("guides installing a missing CLI and logging in to a logged-out one", () => {
    const missing = providerStatusText({
      state: "unavailable",
      providerId: "claude-code",
      reason: "cli-not-installed",
      check: {
        providerId: "claude-code",
        installed: false,
        version: null,
        authentication: "unknown",
      },
    });
    expect(missing.text).toBe("Claude Code: 설치되어 있지 않음");
    expect(missing.guidance).toMatch(/^설치: https:\/\/code\.claude\.com/);
    const loggedOut = providerStatusText({
      state: "unavailable",
      providerId: "codex",
      reason: "cli-not-logged-in",
      check: {
        providerId: "codex",
        installed: true,
        version: "2.1.3",
        authentication: "unauthenticated",
      },
    });
    expect(loggedOut.text).toBe("Codex CLI: 설치됨(2.1.3), 로그인되어 있지 않음");
    expect(loggedOut.guidance).toMatch(/^로그인: .*codex login/);
  });

  it("guides logging in when a CLI's login cannot be confirmed, as Settings does", () => {
    const unknown = providerStatusText({
      state: "ready",
      providerId: "claude-code",
      check: {
        providerId: "claude-code",
        installed: true,
        version: "2.1.3",
        authentication: "unknown",
      },
    });
    expect(unknown.text).toBe("Claude Code: 설치됨(2.1.3), 로그인 상태를 확인할 수 없음");
    expect(unknown.guidance).toMatch(/^로그인: 터미널에서 `claude`/);
  });

  it("says the Provider state could not be read, not that no default is chosen", () => {
    expect(
      providerStatusText({
        state: "unavailable",
        providerId: null,
        reason: "status-check-failed",
      }),
    ).toEqual({ text: "상태를 읽지 못함", guidance: null });
  });

  it("says a blocked egress is blocked, in the connection test's words", () => {
    expect(
      providerStatusText({ state: "unavailable", providerId: "codex", reason: "no-consent" }),
    ).toEqual({ text: "Codex CLI: 전송이 막힘(외부 전송 동의 없음)", guidance: null });
    expect(
      providerStatusText({ state: "unavailable", providerId: "codex", reason: "brand-new-code" }),
    ).toEqual({ text: "Codex CLI: 전송이 막힘(brand-new-code)", guidance: null });
  });

  it("says the execution condition stops it, apart from egress (T17 handoff 1)", () => {
    expect(
      providerStatusText({ state: "unavailable", providerId: "codex", reason: "cli-not-verified" }),
    ).toEqual({
      text: "Codex CLI: 실행이 막힘(격리가 검증된 CLI 조합(버전·OS·인자 프로필)이 아님)",
      guidance: null,
    });
    expect(
      providerStatusText({
        state: "unavailable",
        providerId: "claude-code",
        reason: "cli-background-off",
      }),
    ).toEqual({
      text: "Claude Code: 실행이 막힘(백그라운드 실행이 꺼져 있음)",
      guidance:
        '설정 화면에서 "CLI 백그라운드 실행 허용"을 켜면 가져온 자료의 추출이 이 CLI로 실행됩니다. 연결 시험은 켜지 않아도 실행됩니다.',
    });
    expect(
      providerStatusText({
        state: "unavailable",
        providerId: "codex",
        reason: "unverified-background",
      }),
    ).toEqual({
      text: "Codex CLI: 실행이 막힘(격리 미검증 CLI는 백그라운드로 실행하지 않음)",
      guidance: null,
    });
  });
});

describe("DOWNLOAD_APPROVAL", () => {
  it("names where the files come from, how much, and that hashes are checked", () => {
    expect(DOWNLOAD_APPROVAL).toContain("huggingface.co");
    // the large files come from the hosts huggingface.co redirects to (a firewall must allow them)
    expect(DOWNLOAD_APPROVAL).toContain("넘겨 주는");
    expect(DOWNLOAD_APPROVAL).toContain("586 MB");
    expect(DOWNLOAD_APPROVAL).toContain("해시");
  });
});
