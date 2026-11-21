// V01-H2 `site-check`: for each site Connector kind the command prints the
// follow-up notice and exits non-zero (one test per kind, three in all).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const run = (...args: string[]) =>
  spawnSync(process.execPath, [resolve(import.meta.dirname, "site-check.ts"), ...args], {
    encoding: "utf8",
  });

it.each(["site-mail", "site-messenger", "site-wiki"])(
  "%s prints the notice and exits non-zero",
  (kind) => {
    const result = run(kind);
    expect(result.stderr).toBe(`${kind}: 미구현, 배포처 후속\n`);
    expect(result.status).not.toBe(0);
  },
);

it("rejects an unknown kind with usage and a distinct exit code", () => {
  const result = run("site-nope");
  expect(result.stderr).toMatch(/^usage: site-check/);
  expect(result.status).toBe(2);
});
