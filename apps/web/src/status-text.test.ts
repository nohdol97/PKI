// V01-R5, R14: Home states what each part can do, in words; for embedding also
// whether texts leave the machine (a remote embedder is shown as external egress).
import type { RouteResponse } from "@pki/contracts";
import { describe, expect, it } from "vitest";

type LedgerStatus = RouteResponse<"status">["dataProtection"]["ledger"];
import {
  componentText,
  dataProtectionText,
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

const OK: LedgerStatus = {
  state: "ok",
  reapplied: 0,
  unrecoverable: 0,
  unwritable: 0,
  ignoredLines: 0,
  setAsideLedgers: 0,
  setAsideDeletions: 0,
  history: {
    missingCreated: { total: 0, last: null },
    setAside: { total: 0, last: null },
    unrecoverable: { total: 0, last: null },
    ignoredLines: { total: 0, last: null },
    reapplied: { total: 0, last: null },
    seeded: { total: 0, last: null },
  },
};
const protection = (ledger: Partial<LedgerStatus>, legacyCleanup: "done" | "pending" = "done") =>
  dataProtectionText({ legacyCleanup, ledger: { ...OK, ...ledger } });

describe("status.data-protection: dataProtectionText (I04-R6, I04-R17)", () => {
  it("says the clean-up of earlier deletions' traces failed, and that the next start tries again", () => {
    expect(protection({}, "pending")).toBe("이전 삭제의 흔적 정리 실패(다음 시작에 다시 시도)");
  });
  it("says normal only when nothing is wrong and nothing was done at the start", () => {
    expect(protection({})).toBe("정상");
  });
  it("does not say normal when the ledger is degraded, and says what is blocked and what lifts it", () => {
    expect(protection({ state: "degraded" })).toContain("변경을 막고 있습니다");
    expect(protection({ state: "degraded" })).toContain("다시 시작");
    // what degraded means and what to check; never the promise that a restart alone lifts it
    expect(protection({ state: "degraded" })).toContain("삭제가 하나도 사라지지 않도록");
    expect(protection({ state: "degraded" })).toContain("빈 공간");
    expect(protection({ state: "degraded" })).toContain("쓰기 권한");
    expect(protection({ state: "degraded" })).not.toContain("풀립니다");
    expect(protection({ state: "degraded" })).not.toContain("정상");
  });
  it("says a missing ledger was made anew, that deletions after a backup must be collected again, and the rescan limit", () => {
    const text = protection({ state: "missing-created" });
    expect(text).toContain("삭제 장부가 없어 새로 만들었습니다");
    expect(text).toContain("다시 수집");
    expect(text).toContain("전체 재스캔");
  });
  it("shows how many ledgers were set aside and the deletions they hold, and that none was applied", () => {
    expect(protection({ setAsideLedgers: 2, setAsideDeletions: 7 })).toContain(
      "다른 설치의 삭제 장부 2개(삭제 7건)는 적용하지 않고 옆에 두었습니다",
    );
  });
  it("shows the lines that could not be applied or read, and the ones applied again", () => {
    expect(protection({ unrecoverable: 3 })).toContain(
      "다시 적용하지 못한 삭제 3건(이 빌드에 그 수집기가 없거나 연결 정보가 없습니다. 수집기가 돌아오면 시작할 때 다시 적용합니다)",
    );
    expect(protection({ ignoredLines: 2 })).toContain("읽지 못해 무시한 삭제 장부 줄 2개");
    expect(protection({ reapplied: 4 })).toContain("시작할 때 삭제 4건을 다시 적용했습니다");
  });
  it("I04-C11 a deletion that waits is not shown as normal, says the kind's return applies it, and is absent at zero", () => {
    const waiting = protection({ unrecoverable: 1 });
    expect(waiting).toContain("수집기가 돌아오면 시작할 때 다시 적용합니다");
    expect(waiting).not.toBe("정상");
    expect(waiting.startsWith("정상")).toBe(false);
    expect(protection({ unrecoverable: 0 })).not.toContain("시작할 때 다시 적용합니다");
  });
  it("shows the tombstones that could not be written to the ledger, as a count", () => {
    expect(protection({ unwritable: 2 })).toContain("장부에 적을 수 없는 상태의 삭제 2건");
  });
  it("explains what the ledger is once, before the first note about it, in plain words", () => {
    const text = protection({ state: "degraded", unrecoverable: 1 });
    expect(text.match(/삭제 장부는 지운 자료가/g)).toHaveLength(1);
    expect(text).toContain("되살아나지 않도록");
    expect(text).toContain("자료의 내용은 적지 않습니다");
    expect(text.indexOf("삭제 장부는 지운 자료가")).toBeLessThan(
      text.indexOf("변경을 막고 있습니다"),
    );
    expect(protection({})).not.toContain("삭제 장부는 지운 자료가");
  });
  it("lists every note when several hold, the clean-up first", () => {
    const text = protection(
      { state: "degraded", setAsideLedgers: 1, setAsideDeletions: 1 },
      "pending",
    );
    expect(text.startsWith("이전 삭제")).toBe(true);
    expect(text).toContain("변경을 막고 있습니다");
    expect(text).toContain("옆에 두었습니다");
  });
  it("keeps what happened at earlier starts after the current state is ok, with the date of the last time", () => {
    const text = protection({
      history: {
        ...OK.history,
        missingCreated: { total: 2, last: "2026-11-22T09:30:00.000Z" },
        unrecoverable: { total: 1, last: "2026-11-21T01:00:00.000Z" },
      },
    });
    expect(text.startsWith("정상 · ")).toBe(true);
    expect(text).toContain("지난 기록: ");
    expect(text).toContain("삭제 장부가 없어 새로 만듦 2번(마지막 발생: 2026-11-22)");
    expect(text).toContain("다시 적용하지 못한 삭제 1건(마지막 발생: 2026-11-21)");
    expect(text).toContain("삭제 장부는 지운 자료가"); // the history is about the ledger: explained once here
  });
  it("says nothing of the history while nothing ever happened", () => {
    expect(protection({})).toBe("정상");
  });
});
