// V01-R5, R14: Home states what each part can do, in words; for embedding also
// whether texts leave the machine (a remote embedder is shown as external egress).
import { describe, expect, it } from "vitest";
import { componentText, embeddingText } from "./status-text.ts";

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
      "사용 불가: runtime failed (로컬 계산)",
    ],
    [{ state: "unavailable", reason: "status check failed" }, "사용 불가: status check failed"],
    [{ state: "not-implemented" }, "미구현"],
  ] as const)("%o → %s", (status, text) => {
    expect(embeddingText(status)).toBe(text);
  });
});
