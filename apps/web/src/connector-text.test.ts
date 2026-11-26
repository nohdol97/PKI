// I01-R17: the Sources screen marks a Connector whose rescan may have missed
// deletions, so that a source gone at the origin but still shown is not a surprise.
import { CREDENTIAL_REASONS, LOGIN_ERRORS, SYNC_STOP_CODES } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_REASON_TEXT,
  CREDENTIAL_SLOT_STATE_TEXT,
  connectorNote,
  connectorReasonText,
  DELETIONS_MAY_BE_MISSED,
  syncStopText,
} from "./connector-text.ts";

describe("connectorNote", () => {
  it("says deletions during the expired window may be missed, when the Connector says so", () => {
    expect(connectorNote({ id: "c", kind: "k", state: "ready", deletionsMayBeMissed: true })).toBe(
      DELETIONS_MAY_BE_MISSED,
    );
    expect(DELETIONS_MAY_BE_MISSED).toBe("만료된 동안 지워진 원본을 놓쳤을 수 있음");
  });

  it("says nothing otherwise", () => {
    expect(connectorNote({ id: "c", kind: "k", state: "ready" })).toBeUndefined();
    expect(
      connectorNote({ id: "c", kind: "k", state: "ready", deletionsMayBeMissed: false }),
    ).toBeUndefined();
  });
});

describe("syncStopText", () => {
  it("has its own text for every stop code of the closed list", () => {
    const texts = SYNC_STOP_CODES.map(syncStopText);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(SYNC_STOP_CODES.length);
  });
});

describe("credential wording (I06-R14, I06-C11 ⑤)", () => {
  it("has its own text for each of the four reasons, and each says what the user can do", () => {
    const texts = CREDENTIAL_REASONS.map((reason) => CREDENTIAL_REASON_TEXT[reason]);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(CREDENTIAL_REASONS.length);
    expect(CREDENTIAL_REASON_TEXT["credential-missing"]).toContain("입력");
    expect(CREDENTIAL_REASON_TEXT["credential-unreadable"]).toContain("지우고 다시");
    expect(CREDENTIAL_REASON_TEXT["credential-rejected"]).toContain("거부");
    expect(CREDENTIAL_REASON_TEXT["credential-store-unavailable"]).toContain("저장소");
    expect(CREDENTIAL_REASON_TEXT["login-required"]).toContain("로그인 창을 다시 여세요");
  });

  it("has its own text for each state of a slot", () => {
    const states = ["present", "missing", "unavailable"] as const;
    const texts = states.map((state) => CREDENTIAL_SLOT_STATE_TEXT[state]);
    expect(new Set(texts).size).toBe(3);
  });

  it("gives a reason's text only for a credential reason, and nothing otherwise", () => {
    for (const reason of CREDENTIAL_REASONS) {
      expect(connectorReasonText({ id: "c", kind: "k", state: "unavailable", reason })).toBe(
        CREDENTIAL_REASON_TEXT[reason],
      );
    }
    expect(connectorReasonText({ id: "c", kind: "k", state: "unavailable" })).toBeUndefined();
    expect(
      connectorReasonText({
        id: "c",
        kind: "k",
        state: "unavailable",
        reason: "unsupported-sdk-version",
      }),
    ).toBeUndefined();
  });

  it("words the kind mismatch with its cause and the way out, apart from the credential reasons (I05F-R7 ①)", () => {
    const text = connectorReasonText({
      id: "c",
      kind: "k",
      state: "unavailable",
      reason: "instance-kind-mismatch",
    });
    expect(text).toContain("다시 시작");
    expect(text).toContain("다른 종류");
    expect(Object.values(CREDENTIAL_REASON_TEXT)).not.toContain(text);
  });
});

describe("login wording (I06S-C7, R6)", () => {
  it("has its own text for every login error, none empty", async () => {
    const { LOGIN_ERROR_TEXT } = await import("./connector-text.ts");
    const texts = LOGIN_ERRORS.map((error) => LOGIN_ERROR_TEXT[error]);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(LOGIN_ERRORS.length);
  });
});
