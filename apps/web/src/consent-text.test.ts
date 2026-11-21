// V02-T05 review B-S1, A-R2-S1: granting consent to an HTTP Provider also lets
// the extraction jobs send imported sources of the allowed classes to it
// automatically in the background, those already waiting included. A listed CLI
// Provider sends only once the background setting is on (execution-gate.ts).
// The consent screen says both.
import { describe, expect, it } from "vitest";
import { CONSENT_NOTICE } from "./consent-text.ts";

describe("CONSENT_NOTICE", () => {
  it("says nothing is sent before consent", () => {
    expect(CONSENT_NOTICE).toContain("동의하기 전에는 아무것도 보내지 않습니다");
  });

  it("says consent to an HTTP Provider starts automatic background sending, waiting sources included", () => {
    expect(CONSENT_NOTICE).toContain(
      "HTTP Provider(OpenAI 호환 등)에 동의하면 가져온 자료 가운데 허용한 등급의 것은 추출을 위해 백그라운드에서 자동으로 보내지며, 이미 기다리던 것도 함께 보내집니다.",
    );
  });

  it("says a CLI Provider sends only after background execution is turned on in settings", () => {
    expect(CONSENT_NOTICE).toContain(
      "CLI Provider는 동의만으로는 보내지 않고, 설정에서 백그라운드 실행을 켠 뒤에 보냅니다.",
    );
    // no unconditional claim that consent alone sends
    expect(CONSENT_NOTICE).not.toContain("보내지 않습니다. 동의하면");
  });
});
