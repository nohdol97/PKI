// V02-R2: the Sources screen states an import's result in words, and each refused
// line by its number and why; every reason the API can send has a sentence.
import { ImportLineErrorReasonSchema } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import { importSummaryText, lineErrorText } from "./import-text.ts";

describe("importSummaryText", () => {
  it("counts what was read, what became a new version and what was refused", () => {
    expect(
      importSummaryText({ received: 3, created: 2, errors: [{ line: 4, reason: "invalid-json" }] }),
    ).toBe("변경 3건을 읽어 새 version 2건을 저장했습니다. 거부된 줄 1건.");
    expect(importSummaryText({ received: 3, created: 0, errors: [] })).toBe(
      "변경 3건을 읽어 새 version 0건을 저장했습니다. 거부된 줄 0건.",
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
