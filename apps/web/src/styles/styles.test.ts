// UI01-C1..C3: the look lives in stylesheet files only, its colours and sizes are tokens in one file,
// the text colours are readable on their surfaces, and the bundled font is the unmodified original.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(path, "utf8");
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const stylesheets = [
  ...readdirSync(resolve(src, "styles")).map((f) => resolve(src, "styles", f)),
  resolve(src, "screens.css"),
]
  .filter((f) => f.endsWith(".css"))
  .map((file) => ({ file, css: noComments(read(file)) }));
const tokens = stylesheets.find((s) => s.file.endsWith("tokens.css"))?.css ?? "";
const others = stylesheets.filter((s) => !s.file.endsWith("tokens.css"));

const TOKEN_NAMES = [
  "font",
  "fs-meta",
  "fs-sub",
  "fs-body",
  "fs-lead",
  "fs-h3",
  "fs-h2",
  "fs-h1",
  "lh",
  "bg",
  "bg-side",
  "surface",
  "surface-quiet",
  "ink",
  "ink-2",
  "ink-meta",
  "line",
  "line-strong",
  "accent",
  "accent-quiet",
  "on-accent",
  "attn",
  "attn-bg",
  "warn",
  "warn-bg",
  "ok",
  "none",
  "mark",
  "sp-1",
  "sp-2",
  "sp-3",
  "sp-4",
  "sp-5",
  "sp-6",
  "radius",
  "radius-sm",
  "border",
  "control-h",
  "nav-w",
  "list-w",
  "status-h",
];

const defined = (name: string) => new RegExp(`--${name}\\s*:`).test(tokens);
const value = (name: string) => new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(tokens)?.[1]?.trim();

describe("UI01-C1 styles are files, tokens are in one file", () => {
  it("defines every token name, and every var(--x) a stylesheet uses", () => {
    expect(TOKEN_NAMES.filter((n) => !defined(n))).toEqual([]);
    const used = new Set(
      stylesheets.flatMap(({ css }) =>
        [...css.matchAll(/var\(\s*--([\w-]+)/g)].map((m) => m[1] ?? ""),
      ),
    );
    expect([...used].filter((n) => !defined(n))).toEqual([]);
  });

  it("keeps colour values and font-size pixels out of every stylesheet but tokens.css", () => {
    expect(others.length).toBeGreaterThan(0);
    for (const { file, css } of others) {
      expect(css, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, file).not.toMatch(/\b(?:rgba?|hsla?)\(/);
      expect(css, file).not.toMatch(/font-size\s*:[^;}]*\d\s*px/);
    }
  });

  it("loads one same-origin font file, no @import and no other resource", () => {
    const urls = stylesheets.flatMap(({ css }) =>
      [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]),
    );
    expect(urls).toEqual(['"/fonts/PretendardVariable.woff2"']);
    for (const { file, css } of stylesheets) expect(css, file).not.toMatch(/@import/);
  });

  it("keeps style attributes, <style> and outside links out of the screens and index.html", () => {
    const tsx = readdirSync(src)
      .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
      .map((f) => [f, read(resolve(src, f))] as const);
    expect(tsx.length).toBeGreaterThan(10);
    for (const [f, text] of tsx) {
      expect(text, f).not.toMatch(/\bstyle\s*=/);
      expect(text, f).not.toMatch(/<style/i);
    }
    const html = read(resolve(src, "../index.html"));
    expect(html).not.toMatch(/<style|\sstyle\s*=|<link/i);
  });

  it("is loaded by main.tsx in the cascade order", () => {
    const main = read(resolve(src, "main.tsx"));
    const order = ["tokens", "base", "shell", "components"].map((n) =>
      main.indexOf(`./styles/${n}.css`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(main.indexOf("./screens.css")).toBeGreaterThan(order[3] ?? Infinity);
  });
});

const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r = 0, g = 0, b = 0] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    channel(v / 255),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const colour = (name: string) => {
  const v = value(name);
  expect(v, `--${name}`).toMatch(/^#[0-9a-fA-F]{6}$/);
  return v ?? "";
};

describe("UI01-C2 contrast of the token values", () => {
  it.each([
    ["ink", "bg", 7],
    ["ink", "surface", 7],
    ["ink-2", "surface", 4.5],
    ["ink-meta", "surface-quiet", 4.5],
    ["accent", "surface", 4.5],
    ["on-accent", "accent", 4.5],
    ["attn", "attn-bg", 4.5],
    ["warn", "warn-bg", 4.5],
  ])("--%s on --%s is at least %s:1", (fg, bg, min) => {
    expect(contrast(colour(fg), colour(bg))).toBeGreaterThanOrEqual(min);
  });

  it("sets the body text between 15 and 17px", () => {
    const px = Number.parseFloat(value("fs-body") ?? "");
    expect(px).toBeGreaterThanOrEqual(15);
    expect(px).toBeLessThanOrEqual(17);
  });
});

const FONT_SHA256 = "9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4";

describe("UI01-C3 the bundled font is the unmodified original", () => {
  const dir = resolve(src, "../public/fonts");
  it("matches the hash in this test and in NOTICE.txt", () => {
    const sha = createHash("sha256")
      .update(readFileSync(resolve(dir, "PretendardVariable.woff2")))
      .digest("hex");
    expect(sha).toBe(FONT_SHA256);
    expect(read(resolve(dir, "NOTICE.txt"))).toContain(FONT_SHA256);
  });

  it("ships the OFL text with Pretendard's copyright line", () => {
    const ofl = read(resolve(dir, "OFL.txt"));
    expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(ofl).toMatch(/Copyright \(c\) 2021, Kil Hyung-jin/);
  });
});
