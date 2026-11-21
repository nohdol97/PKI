// I02A-H2: the survey runner refuses a folder inside this repository and never
// prints file names or text for a folder outside it. It runs as a child process,
// the way `pnpm --filter @pki/document-normalize survey <folder>` runs it.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, describe, expect, it } from "vitest";

const surveyPath = join(import.meta.dirname, "survey.ts");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [surveyPath, ...args], { encoding: "utf8" });

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "survey-")));
  created.push(dir);
  return dir;
};

// Each case starts a Node process that loads the parsers; the default 5 s is too tight under load.
describe("survey runner", { timeout: 60_000 }, () => {
  it("refuses a folder inside this repository with a notice and a non-zero exit (H2)", () => {
    const r = run(import.meta.dirname);
    expect(r.status).not.toBe(0);
    expect(r.stdout.startsWith("배포처 후속")).toBe(true);
  });

  it("refuses a repository folder given through a symlink and with a trailing component", () => {
    const outside = tmp();
    symlinkSync(import.meta.dirname, join(outside, "link"));
    const viaLink = run(join(outside, "link"));
    expect(viaLink.status).not.toBe(0);
    expect(viaLink.stdout.startsWith("배포처 후속")).toBe(true);
    const dotted = run(join(import.meta.dirname, "formats", ".."));
    expect(dotted.status).not.toBe(0);
    expect(dotted.stdout.startsWith("배포처 후속")).toBe(true);
  });

  // `realpathSync` (JS) keeps the caller's letter case; only the native one canonicalizes it.
  const caseInsensitive = existsSync(import.meta.dirname.toUpperCase());
  it.skipIf(!caseInsensitive)(
    "refuses a case-variant spelling of a repository folder on a case-insensitive file system",
    () => {
      const upper = import.meta.dirname.toUpperCase();
      expect(upper).not.toBe(import.meta.dirname);
      const r = run(upper);
      expect(r.status).not.toBe(0);
      expect(r.stdout.startsWith("배포처 후속")).toBe(true);
    },
  );

  it("prints only counts for a folder outside the repository, never names or text (H2)", () => {
    const dir = tmp();
    const marker = "ZQXMARK7731";
    mkdirSync(join(dir, `sub-${marker}`));
    writeFileSync(join(dir, `${marker}-a.txt`), `${marker} 본문\n둘째 줄\n`);
    writeFileSync(
      join(dir, `sub-${marker}`, `${marker}.csv`),
      iconv.encode(`${marker},똠\n1\n`, "cp949"),
    );
    writeFileSync(join(dir, `${marker}-bad.json`), `{"${marker}":`);
    writeFileSync(join(dir, `${marker}.unknown`), marker);
    symlinkSync(join(dir, `${marker}-a.txt`), join(dir, `${marker}-link.txt`));

    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(marker);
    expect(r.stderr).not.toContain(marker);
    expect(JSON.parse(r.stdout)).toEqual({
      files: 4,
      symlinks: 1,
      others: 0,
      success: { csv: 1, txt: 1 },
      errors: { corrupt: 1, "unsupported-format": 1 },
      limitations: { "csv.ragged-rows": 1, "text.encoding-fallback": 1 },
      encodings: { "euc-kr": 1, "utf-8": 1 },
    });
  });

  it("exits non-zero with usage when the folder is missing, without echoing the argument", () => {
    const none = run();
    expect(none.status).not.toBe(0);
    const bad = run(join(tmp(), "ZQXNOPE-does-not-exist"));
    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).not.toContain("ZQXNOPE");
  });
});
