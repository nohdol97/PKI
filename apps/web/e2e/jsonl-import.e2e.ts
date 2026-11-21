// V02-R2, C3 (re-import) in the browser: on the Sources screen a JSONL file is
// imported through the backend; a malformed line is reported by its number while
// the other lines are stored and listed, and importing the same file again stores
// no new version; a source deleted on the screen cannot be imported again
// (V02-R12). The fixtures are the V02 synthetic ones.
import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { webConfig } from "../dev/dev-server.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
const record = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8").trim()) as { title: string };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

let dir: string;
let vite: ViteDevServer;
let port: number;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-e2e-import-"));
  port = await freePort();
  // An empty fixtures file: nothing but the import puts sources in this run's DB.
  writeFileSync(join(dir, "empty.jsonl"), "");
  vite = await createServer({
    ...webConfig({ port, dataDir: join(dir, "data"), fixtures: join(dir, "empty.jsonl") }),
    configFile: false,
    logLevel: "warn",
  });
  await vite.listen();
});
test.afterEach(async () => {
  await vite.close();
  rmSync(dir, { recursive: true, force: true });
});

test("imports a JSONL file on the Sources screen, reporting a bad line by number", async ({
  page,
}) => {
  const file = join(dir, "import.jsonl");
  writeFileSync(
    file,
    [
      readFileSync(join(FIXTURES, "v02-mail.jsonl"), "utf8").trim(),
      "{not json",
      readFileSync(join(FIXTURES, "v02-wiki.jsonl"), "utf8").trim(),
    ].join("\n"),
  );
  const titles = [record("v02-mail.jsonl").title, record("v02-wiki.jsonl").title];

  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole("navigation").getByRole("button", { name: "원본" }).click();
  await expect(page.getByText("저장된 원본이 없습니다.")).toBeVisible();

  const input = page.getByLabel("JSONL 파일 가져오기");
  await input.setInputFiles(file);
  await expect(page.getByRole("status")).toHaveText(
    "변경 2건을 읽어 새 version 2건을 저장했습니다. 거부된 줄 1건.",
  );
  await expect(page.getByRole("list", { name: "거부된 줄" })).toHaveText(
    "2번째 줄: JSON 형식이 아닙니다",
  );
  for (const title of titles)
    await expect(page.getByRole("cell", { name: title, exact: true })).toBeVisible();

  await input.setInputFiles(file);
  await expect(page.getByRole("status")).toHaveText(
    "변경 2건을 읽어 새 version 0건을 저장했습니다. 거부된 줄 1건.",
  );
  for (const title of titles)
    await expect(page.getByRole("cell", { name: title, exact: true })).toHaveCount(1);
});

test("deletes a source from the Sources screen, after which importing it again is refused", async ({
  page,
}) => {
  const file = join(dir, "mail.jsonl");
  writeFileSync(file, readFileSync(join(FIXTURES, "v02-mail.jsonl"), "utf8"));
  const { title } = record("v02-mail.jsonl");

  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByRole("navigation").getByRole("button", { name: "원본" }).click();
  const input = page.getByLabel("JSONL 파일 가져오기");
  await input.setInputFiles(file);
  await expect(page.getByRole("cell", { name: title, exact: true })).toBeVisible();

  await page.getByRole("button", { name: `${title} 삭제` }).click();
  const confirm = page.getByRole("alertdialog", { name: "원본 삭제 확인" });
  await expect(confirm).toContainText("지운 원본은 다시 가져올 수 없습니다.");
  await confirm.getByRole("button", { name: "취소" }).click();
  await expect(page.getByRole("cell", { name: title, exact: true })).toBeVisible();

  await page.getByRole("button", { name: `${title} 삭제` }).click();
  await confirm.getByRole("button", { name: "지우기" }).click();
  await expect(page.getByRole("status")).toHaveText(`「${title}」을(를) 지웠습니다.`);
  await expect(page.getByText("저장된 원본이 없습니다.")).toBeVisible();

  await input.setInputFiles(file);
  await expect(page.getByRole("status")).toHaveText(
    "변경 1건을 읽어 새 version 0건을 저장했습니다. 거부된 줄 1건.",
  );
  await expect(page.getByRole("list", { name: "거부된 줄" })).toHaveText(
    "1번째 줄: 삭제되거나 권한이 철회된 원본입니다",
  );
  await expect(page.getByText("저장된 원본이 없습니다.")).toBeVisible();
});
