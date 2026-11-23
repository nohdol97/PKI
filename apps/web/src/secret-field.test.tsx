// I06F-C2 (I06F-R1, R2): the one secret input, drawn as static markup. Events and focus have no DOM double in
// apps/web; they are closed by the Playwright specs (connector-credential, provider-settings).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecretField } from "./secret-field.tsx";

const draw = (props: Partial<Parameters<typeof SecretField>[0]> = {}) =>
  renderToStaticMarkup(
    <SecretField inputLabel="값" saveText="저장" onAction={() => {}} {...props} />,
  );
const tag = (html: string, name: "input" | "button", n = 0) =>
  html.match(new RegExp(`<${name}[^>]*>`, "g"))?.[n] ?? "";

describe("SecretField", () => {
  it("is a password input with autocomplete off and no value attribute, and save is off until something is typed", () => {
    const html = draw();
    expect(tag(html, "input")).toContain('type="password"');
    expect(tag(html, "input")).toMatch(/autocomplete="off"/i); // React writes the camelCase name; HTML reads it either way
    expect(tag(html, "input")).not.toContain("value");
    expect(tag(html, "button")).toContain("disabled");
  });

  it("draws a delete button only when a value is stored", () => {
    expect(draw().match(/<button/g)).toHaveLength(1);
    const html = draw({ remove: { label: "삭제하기", text: "삭제" } });
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(tag(html, "button", 1)).toContain('aria-label="삭제하기"');
  });

  it("turns the input and save off together when disabled", () => {
    const html = draw({ disabled: true });
    expect(tag(html, "input")).toContain("disabled");
    expect(tag(html, "button")).toContain("disabled");
  });

  it("names the input by aria-label, or by a drawn label when asked", () => {
    expect(tag(draw({ inputLabel: "A 값" }), "input")).toContain('aria-label="A 값"');
    const shown = draw({ inputLabel: "A 값", showLabel: true });
    expect(shown).toContain("<label>A 값<input");
    expect(tag(shown, "input")).not.toContain("aria-label");
  });
});
