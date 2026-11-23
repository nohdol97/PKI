// What the V02 screen E2E share (evidence.e2e.ts, v02-flow.e2e.ts): the fixtures'
// expected evidence and titles, a free loopback port, and the walk from Home's one
// Insight through its evidence to each source span. Not a test file itself.
import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../../..");

interface Evidence {
  record_id: string;
  version: number;
  quote: string;
}
const expected = JSON.parse(readFileSync(join(ROOT, "fixtures/v02-expected.json"), "utf8")) as {
  sets: Record<string, { files: string[]; insights: { evidence: Evidence[] }[] }>;
};
const records = (file: string) =>
  readFileSync(join(ROOT, "fixtures", file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string; title: string });

/** Fixture record id -> its title. */
export const titleOf = new Map(
  ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl", "v02-malicious.jsonl"].flatMap(
    (file) => records(file).map((r) => [r.id, r.title] as const),
  ),
);

/** The JSONL text of one fixture set of fixtures/v02-expected.json, file after file. */
export function fixtureSetText(set: string): string {
  const files = expected.sets[set]?.files;
  if (!files) throw new Error(`unknown fixture set: ${set}`);
  return files.map((file) => readFileSync(join(ROOT, "fixtures", file), "utf8").trim()).join("\n");
}

/** The title of a fixture file's one record. */
export const recordTitle = (file: string) => records(file)[0]?.title as string;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

/** A request that would leave this machine: http(s) to anything but loopback. */
export const remote = (url: string) => {
  const { protocol, hostname } = new URL(url);
  return (protocol === "http:" || protocol === "https:") && hostname !== "127.0.0.1";
};

/** The list's own rows: an Insight's fact-line list nests inside its row (P01-R13), so no deeper item counts. */
export const insightItems = (page: Page) =>
  page.getByRole("list", { name: "Insight 목록" }).locator(":scope > li");

/** Opens the one Insight's evidence by keyboard, checks each source span, returns the source view. */
export async function openEvidence(page: Page, set: string) {
  const insights = insightItems(page);
  await expect(insights).toHaveCount(1);
  const insight = insights.first();
  await expect(insight.getByText("추론", { exact: true })).toBeVisible();
  await expect(insight).toContainText("확정 사실이 아닙니다");
  await expect(page.getByText("확정", { exact: true })).toHaveCount(0);

  const open = insight.getByRole("button", { name: /근거 보기/ });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "근거", exact: true })).toBeFocused();
  const list = page.getByRole("list", { name: "근거 목록" }).getByRole("listitem");
  const want = expected.sets[set]?.insights[0]?.evidence ?? [];
  await expect(list).toHaveCount(want.length);
  expect(want).toHaveLength(3);

  const source = page.getByRole("region", { name: "원본 보기" });
  for (const evidence of want) {
    const title = titleOf.get(evidence.record_id) as string;
    const item = list.filter({ hasText: title });
    await expect(item).toContainText(`version ${evidence.version}`);
    await expect(item).toContainText(evidence.quote);
    await item.getByRole("button", { name: `원본 보기: ${title}` }).press("Enter");
    await expect(source.getByRole("heading", { name: title })).toBeVisible();
    await expect(source.getByRole("heading", { name: "원본 보기" })).toBeFocused();
    await expect(source).toContainText(`version ${evidence.version}`);
    await expect(source.getByText("가져온 자료(신뢰하지 않음)")).toBeVisible();
    await expect(source.locator("mark")).toHaveText(evidence.quote);
    // long lines wrap: the stylesheet loads under the shell's CSP too
    await expect(source.locator("pre")).toHaveCSS("white-space", "pre-wrap");
    // screen-reader words around the quote are generated content, not copyable text
    const marks = await source
      .locator("mark")
      .evaluate((m) => [
        getComputedStyle(m, "::before").content,
        getComputedStyle(m, "::after").content,
      ]);
    expect(marks).toEqual(['"[강조된 인용 시작] "', '" [강조된 인용 끝]"']);
  }
  // reopening the same evidence moves focus to the source heading again
  const last = titleOf.get(want[want.length - 1]?.record_id ?? "") as string;
  const reopen = list.filter({ hasText: last }).getByRole("button", { name: `원본 보기: ${last}` });
  await reopen.focus();
  await page.keyboard.press("Enter");
  await expect(source.getByRole("heading", { name: "원본 보기" })).toBeFocused();
  return source;
}
