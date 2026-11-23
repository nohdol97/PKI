// X01-C6b ① the keyword query drops a noise word only when the whole word matches (X01-R21); the route cue words stay substring matches.
import { describe, expect, it } from "vitest";
import { keywordTokens } from "./routing.ts";

describe("X01-C6b ① keywordTokens", () => {
  it("keeps content words that merely start with a noise word and drops the noise word with a particle", () => {
    const tokens = keywordTokens("의존성 관계자 이전했다 의존은");
    expect(tokens).toEqual(expect.arrayContaining(["의존성", "관계자", "이전했다"]));
    expect(tokens).not.toContain("의존");
  });
});
