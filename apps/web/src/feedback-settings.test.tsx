// P5F-R5: the one checkbox of the type step's switch, off until the user turns it on.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FeedbackLearnedCheckbox } from "./feedback-settings.tsx";

describe("FeedbackLearnedCheckbox", () => {
  it("shows the switch as it is stored", () => {
    const off = renderToStaticMarkup(
      <FeedbackLearnedCheckbox learned={false} onChange={() => {}} />,
    );
    expect(off).toContain('type="checkbox"');
    expect(off).not.toContain("checked");
    const on = renderToStaticMarkup(<FeedbackLearnedCheckbox learned onChange={() => {}} />);
    expect(on).toContain("checked");
  });
});
