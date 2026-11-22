// V02-R2: the Sources screen states an import's result in words, and each refused
// line by its number and why; every reason the API can send has a sentence.
import { ImportLineErrorReasonSchema } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { importSummaryText, lineErrorText } from "./import-text.ts";

describe("importSummaryText", () => {
  it("counts what was read, what became a new version and what was refused", () => {
    expect(
      importSummaryText({
        received: 3,
        created: 2,
        errors: [{ line: 4, reason: "invalid-json" }],
        errorCount: 1,
      }),
    ).toBe("변경 3건을 읽어 새 version 2건을 저장했습니다. 거부된 줄 1건.");
    expect(importSummaryText({ received: 3, created: 0, errors: [], errorCount: 0 })).toBe(
      "변경 3건을 읽어 새 version 0건을 저장했습니다. 거부된 줄 0건.",
    );
  });

  it("says when only the first refused lines are listed (review B-S1)", () => {
    const errors = Array.from({ length: 100 }, (_, i) => ({
      line: i + 1,
      reason: "invalid-json" as const,
    }));
    expect(importSummaryText({ received: 0, created: 0, errors, errorCount: 4000 })).toBe(
      "변경 0건을 읽어 새 version 0건을 저장했습니다. 거부된 줄 4000건(처음 100건만 보입니다).",
    );
  });
});

describe("lineErrorText", () => {
  it("names the line and the reason, with the field when there is one", () => {
    expect(lineErrorText({ line: 2, reason: "invalid-json" })).toBe(
      "2번째 줄: JSON 형식이 아닙니다",
    );
    expect(lineErrorText({ line: 5, reason: "invalid-record", field: "created_at" })).toBe(
      "5번째 줄: 필드 형식이 맞지 않습니다 (created_at)",
    );
  });

  it.each(ImportLineErrorReasonSchema.options)("has a sentence for %s", (reason) => {
    expect(lineErrorText({ line: 1, reason })).toMatch(/^1번째 줄: \S/);
  });
});

describe("a deletion line the ledger cannot record (I04-R17)", () => {
  it("has its own words, not the bare failure's", () => {
    const text = lineErrorText({ line: 3, reason: "ledger-unwritable" });
    expect(text).toContain("3번째 줄");
    expect(text).toContain("삭제 장부에 적을 수 없는");
    expect(text).not.toContain("저장이 실패");
  });
});
