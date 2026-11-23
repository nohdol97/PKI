// X01-T6 `docs.x01` (R16): the I04 registration table says an answer's context, citations and cache are computed
// when read and stored nowhere, and hands the vector projection's real writes to the post-R07 vector work; the
// site-setup checklist carries the five deployment-fork items S37~S41 once each; the README and the docs index
// name the Ask screen and the X01 spec. A separate file from the other site-setup tests.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

describe("docs.x01 (X01-T6)", () => {
  it("the I04 registration table has no row to register for the answer context, and the vector write is not X01's", () => {
    const i04 = read("docs/specs/2026-11-21-I04-invalidation.md");
    const answerRow = /^\| 답변 문맥, 인용, 답변 캐시 \|.*$/m.exec(i04)?.[0] ?? "";
    expect(answerRow).toContain("읽을 때 계산, 저장하지 않음");
    expect(answerRow).toContain("등록할 행 없음");
    expect(answerRow).not.toContain("X01이 정함");
    const vectorRow = /^\| 벡터 투영 \|.*$/m.exec(i04)?.[0] ?? "";
    expect(vectorRow).toContain("R07 뒤");
    expect(vectorRow).not.toContain("실제 쓰기는 X01-C4");
  });

  it("site-setup carries S37~S41 once each, as items of the X01 section", () => {
    const site = read("docs/site-setup.md");
    for (const n of [37, 38, 39, 40, 41]) {
      expect([...site.matchAll(new RegExp(`^- \\[[ x]\\] \\*\\*S${n} `, "gm"))]).toHaveLength(1);
    }
    expect(site).toContain("### 질문의 실측");
  });

  it("the README and the docs index name the Ask screen and the X01 spec, and ARCHITECTURE the read path", () => {
    expect(read("README.md")).toContain("질문");
    expect(read("docs/README.md")).toContain("specs/2026-11-23-X01-retrieval-qa.md");
    const arch = read("docs/ARCHITECTURE.md");
    expect(arch).toContain("### 6.1 질문에서 답까지(X01)");
    expect(arch).toContain("X01(#30)이 `search`를 부르는 자리");
  });
});
