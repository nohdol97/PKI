// I03-R17, I03-C3 `settings.background-text`: the Settings screen's "백그라운드 실행"
// explanation says what a background run now includes (scheduled work while the user
// is away), that an unverified CLI combination never runs in the background, and that
// an API-key Provider runs automatically whatever this setting says. The component is
// drawn, so a copy of the old sentence left in App.tsx fails here too.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api.ts";
import { BackgroundExecution } from "./App.tsx";
import { BACKGROUND_EXECUTION_TEXT } from "./background-text.ts";

// effects do not run in a static render: the explanation is there before any answer
const noApi = (() => Promise.reject(new Error("not called"))) as unknown as ApiClient;
const drawn = () => {
  const html = renderToStaticMarkup(<BackgroundExecution api={noApi} />);
  return html.replaceAll(/<[^>]+>/g, "").replaceAll(/\s+/g, " ");
};

describe("settings.background-text", () => {
  it("the explanation draws the three things R17 names", () => {
    const text = drawn();
    for (const phrase of ["자리에 없을 때", "자동으로", "API 키"]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it("is the text R17 gives: scheduled runs included, unverified combinations never, API key outside the setting, default off", () => {
    expect(BACKGROUND_EXECUTION_TEXT).toBe(
      "켜면 격리가 검증된 CLI 조합이 백그라운드 작업을 실행합니다. 여기에는 가져오기 뒤의 추출과, " +
        "사용자가 자리에 없을 때 정해진 주기에 따라 자동으로 도는 작업이 모두 들어갑니다. " +
        "검증되지 않은 조합은 이 설정과 관계없이 백그라운드로 실행하지 않습니다. " +
        "API 키 Provider는 이 설정과 관계없이, 동의하고 전송 정책이 허용한 범위에서 같은 작업을 자동으로 실행합니다. " +
        "기본값은 끔입니다.",
    );
    expect(drawn()).toContain(BACKGROUND_EXECUTION_TEXT);
  });
});
