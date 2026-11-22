import { expect, it } from "vitest";
import { outcomeText } from "./activity-text.ts";

it("words the outcomes a started attempt can end in without an answer, and shows others as their code", () => {
  expect(outcomeText("interrupted")).toBe("중단됨");
  expect(outcomeText("started")).toBe("진행 중");
  expect(outcomeText("cancelled")).toBe("취소됨");
  expect(outcomeText("provider-error")).toBe("provider-error");
});
