// V01-R5 (안내): a CLI that is not installed shows how to install it; one that is
// not logged in, or whose login cannot be told, shows how to log in.
import { describe, expect, it } from "vitest";
import { connectionTestGuidance, providerCheckText, providerName } from "./provider-text.ts";

const check = (over: Partial<Parameters<typeof providerCheckText>[0]>) => ({
  providerId: "codex" as const,
  installed: true,
  version: "0.155.1",
  authentication: "authenticated" as const,
  ...over,
});

describe("provider text", () => {
  it("names every Provider", () => {
    expect(providerName("claude-code")).toBe("Claude Code");
    expect(providerName("codex")).toBe("Codex CLI");
    expect(providerName("openai-compatible")).toBe("OpenAI 호환 API");
    expect(providerName("local-model")).toBe("로컬 모델");
  });

  it("shows the version of a logged-in CLI and no guidance", () => {
    expect(providerCheckText(check({}))).toEqual({
      state: "설치됨(0.155.1), 로그인됨",
      guidance: null,
    });
  });

  it("guides installing a CLI that is not installed", () => {
    for (const providerId of ["claude-code", "codex"] as const) {
      const text = providerCheckText(
        check({ providerId, installed: false, version: null, authentication: "unknown" }),
      );
      expect(text.state).toBe("설치되어 있지 않음");
      expect(text.guidance).toContain("설치");
      expect(text.guidance).toMatch(/https:\/\//);
    }
    expect(
      providerCheckText(check({ installed: false, version: null, authentication: "unknown" }))
        .guidance,
    ).toContain("codex login");
  });

  it("guides logging in when not logged in or when it cannot be told", () => {
    const out = providerCheckText(check({ authentication: "unauthenticated" }));
    expect(out.state).toBe("설치됨(0.155.1), 로그인되어 있지 않음");
    expect(out.guidance).toContain("codex login");
    const unknown = providerCheckText(
      check({ providerId: "claude-code", version: "2.1.3", authentication: "unknown" }),
    );
    expect(unknown.state).toBe("설치됨(2.1.3), 로그인 상태를 확인할 수 없음");
    expect(unknown.guidance).toContain("claude");
    expect(unknown.guidance).toContain("로그인");
  });

  it("says when the version could not be read", () => {
    expect(providerCheckText(check({ version: null })).state).toBe(
      "설치됨(버전을 읽지 못함), 로그인됨",
    );
  });

  it("words an HTTP Provider by its endpoint and key, not by an install", () => {
    const http = { providerId: "openai-compatible" as const, version: null };
    expect(providerCheckText({ ...http, installed: false, authentication: "unknown" })).toEqual({
      state: "주소가 설정되지 않음",
      guidance: null,
    });
    expect(
      providerCheckText({ ...http, installed: true, authentication: "unauthenticated" }),
    ).toEqual({ state: "API 키 없음", guidance: null });
    expect(providerCheckText({ ...http, installed: true, authentication: "unknown" })).toEqual({
      state: "주소 설정됨",
      guidance: null,
    });
  });

  it("says on Windows that only the native .exe install runs", () => {
    for (const providerId of ["claude-code", "codex"] as const) {
      const text = providerCheckText(
        check({ providerId, installed: false, version: null, authentication: "unknown" }),
      );
      expect(text.guidance).toContain(".exe");
      expect(text.guidance).toContain(".cmd");
    }
  });

  it("guides from a connection test result that carries a check", () => {
    expect(
      connectionTestGuidance({ outcome: "blocked", reason: "no-consent", isolation: null }),
    ).toBeNull();
    const missing = connectionTestGuidance({
      outcome: "blocked",
      reason: "cli-not-verified",
      isolation: null,
      providerCheck: {
        providerId: "claude-code",
        installed: false,
        version: null,
        authentication: "unknown",
      },
    });
    expect(missing).toContain("Claude Code: 설치되어 있지 않음");
    expect(missing).toContain("설치:");
  });

  it("says when the CLI's run folder cannot be used, and how to fix it", () => {
    const text = providerCheckText(
      check({
        providerId: "codex",
        installed: true,
        version: null,
        authentication: "unknown",
        problem: "cli-runs-root-refused",
      }),
    );
    expect(text.state).toBe("실행 폴더를 쓸 수 없음");
    expect(text.guidance).toContain("cli-runs");
    expect(text.guidance).toContain("0700");
  });
});
