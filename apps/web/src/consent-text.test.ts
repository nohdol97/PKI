// V02-T05 review B-S1: granting consent to a Provider also lets the extraction
// jobs send imported sources of the allowed classes to it automatically in the
// background, those already waiting included. The consent screen says so.
import { describe, expect, it } from "vitest";
import { CONSENT_NOTICE } from "./consent-text.ts";

describe("CONSENT_NOTICE", () => {
  it("says nothing is sent before consent", () => {
    expect(CONSENT_NOTICE).toContain("동의하기 전에는 아무것도 보내지 않습니다");
  });

  it("says consent starts automatic background sending of imported sources, waiting ones included", () => {
    expect(CONSENT_NOTICE).toContain(
      "동의하면 가져온 자료 가운데 허용한 등급의 것은 추출을 위해 백그라운드에서 자동으로 보내지며, 이미 기다리던 것도 함께 보내집니다.",
    );
  });
});
