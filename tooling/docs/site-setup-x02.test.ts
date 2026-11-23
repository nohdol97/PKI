// X02-T6 `docs.x02` (R4, D2): the I04 registration table says the Explore reads are computed when read and stored
// nowhere, and names the check that holds their read gate; the site-setup checklist carries the deployment-fork
// item S42 once; the README and the docs index name the two screens and the X02 spec. A separate file from the
// other site-setup tests.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

describe("docs.x02 (X02-T6)", () => {
  it("the I04 registration table has no row to register for the Explore reads, and names X02-C2b", () => {
    const row = /^\| 탐색 읽기 \|.*$/m.exec(read("docs/specs/2026-11-21-I04-invalidation.md"))?.[0] ?? "";
    expect(row).toContain("읽을 때 계산, 저장하지 않음");
    expect(row).toContain("등록할 행 없음");
    expect(row).toContain("X02-C2b");
  });

  it("site-setup carries S42 once, under the X02 section", () => {
    const site = read("docs/site-setup.md");
    expect([...site.matchAll(/^- \[[ x]\] \*\*S42 /gm)]).toHaveLength(1);
    expect(site).toContain("### 탐색 화면의 확인");
  });

  it("the README names the two screens and the docs index lists the X02 spec", () => {
    const readme = read("README.md");
    expect(readme).toContain("탐색");
    expect(readme).toContain("지식 검토");
    expect(read("docs/README.md")).toContain("specs/2026-11-23-X02-explore-ux.md");
  });
});
