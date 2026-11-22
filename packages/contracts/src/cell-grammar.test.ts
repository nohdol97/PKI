// S03-C1/C3 `analytical.value-types`: the boundary examples of S03-R3's number and
// date grammar, as written in the spec.
import { describe, expect, it } from "vitest";
import { isDateText, isNumberText } from "./index.ts";

describe("analytical.value-types: number grammar (S03-R3)", () => {
  it.each(["1000.50", " 42", "-3", "1e3", "1e+21", "+5", ".5", "5.", "007", "1E-3", "42\t"])(
    "%j is a number",
    (text) => expect(isNumberText(text)).toBe(true),
  );
  it.each([
    "1,000",
    "₩1000",
    "10%",
    "NaN",
    "Infinity",
    "",
    "   ",
    ".",
    "1e",
    "0x10",
    "1 000",
    "１２",
    "--3",
    "2024-01-31",
  ])("%j is not a number", (text) => expect(isNumberText(text)).toBe(false));
});

describe("analytical.value-types: date grammar (S03-R3)", () => {
  it.each([
    "2024-01-31",
    "2024-01-31T09:00:00.000Z",
    "2024-01-31 09:00",
    "2024-01-31T09:00:00+09:00",
    "2024-02-29",
    " 2024-01-31 ",
    "2024-01-31T09:00:00.5",
  ])("%j is a date", (text) => expect(isDateText(text)).toBe(true));
  it.each([
    "2024/01/31",
    "2024-02-30",
    "2023-02-29",
    "2024-13-01",
    "2024-00-10",
    "2024-01-00",
    "20240131",
    "2024-1-31",
    "2024-01-31T09",
    "2024-01-31T09:00:00.Z",
    "",
  ])("%j is not a date", (text) => expect(isDateText(text)).toBe(false));

  it("20240131 is a number, not a date", () => {
    expect(isNumberText("20240131")).toBe(true);
    expect(isDateText("20240131")).toBe(false);
  });
});
