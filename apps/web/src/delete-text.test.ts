// V02-R12: before the Sources screen deletes a source it says what goes and that
// the source cannot be imported again; after, it says what happened.
import { describe, expect, it } from "vitest";
import { deleteConfirmText, deletedText } from "./delete-text.ts";

describe("deleteConfirmText", () => {
  it("names the source and says every version, its evidence and the knowledge only it held go for good", () => {
    expect(deleteConfirmText("합성 일지")).toBe(
      "「합성 일지」의 모든 version과 그 근거, 이 원본에만 근거한 지식을 지웁니다. 지운 원본은 다시 가져올 수 없습니다.",
    );
  });
});

describe("deletedText", () => {
  it("tells a deletion from a source deleted before", () => {
    expect(deletedText("합성 일지", "deleted")).toBe("「합성 일지」을(를) 지웠습니다.");
    expect(deletedText("합성 일지", "already-deleted")).toBe(
      "「합성 일지」은(는) 이미 지워졌습니다.",
    );
  });
});
