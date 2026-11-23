// X02B-C7 ① (R12): a list read in pages. "더 보기" reads the next page with `before` = the last answer's `next`
// and appends it; once `next` is null there is no button.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MoreButton, nextPage } from "./paged-list.tsx";

describe("paged list", () => {
  it("reads the first page without before, then the next with before = next, appending the rows", async () => {
    const read = vi
      .fn<(before?: number) => Promise<{ rows: string[]; next: number | null }>>()
      .mockResolvedValueOnce({ rows: ["a", "b"], next: 7 })
      .mockResolvedValueOnce({ rows: ["c"], next: null });
    const first = await nextPage(read, undefined);
    expect(first).toEqual({ rows: ["a", "b"], next: 7 });
    const second = await nextPage(read, first);
    expect(second).toEqual({ rows: ["a", "b", "c"], next: null });
    expect(read.mock.calls).toEqual([[undefined], [7]]);
  });

  it("draws the 더 보기 button only while there is a next page", () => {
    expect(
      renderToStaticMarkup(
        <MoreButton next={7} loading={false} onMore={() => undefined} label="원본" />,
      ),
    ).toContain("원본 더 보기");
    expect(
      renderToStaticMarkup(
        <MoreButton next={null} loading={false} onMore={() => undefined} label="원본" />,
      ),
    ).toBe("");
  });
});
