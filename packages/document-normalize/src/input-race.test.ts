// I02A-R2 residual race (review B6): a regular file swapped for a FIFO between the type
// check and the open must not block the open. The type check is made to see a regular
// file; the path really is a FIFO, so only O_NONBLOCK keeps `open` from waiting for a writer.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS } from "./limits.ts";

const lie = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (path: string, ...rest: unknown[]) => {
      const info = await (actual.stat as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
      return path === lie.path ? Object.assign(info as object, { isFile: () => true }) : info;
    },
  };
});

const { readInput } = await import("./input.ts");

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pki-race-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("B6 a FIFO swapped in after the type check", () => {
  it.skipIf(process.platform === "win32")(
    "is refused as not-a-file instead of blocking the open",
    async () => {
      const fifo = join(base, "swapped.txt");
      execFileSync("mkfifo", [fifo]);
      lie.path = fifo;
      let release: (() => Promise<void>) | undefined;
      const outcome = await Promise.race([
        readInput({ kind: "path", path: fifo }, DEFAULT_LIMITS),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => {
            // Opening the write end lets a blocked open() finish, so the worker is not leaked.
            void open(fifo, "r+").then((h) => {
              release = () => h.close();
            });
            resolve("blocked");
          }, 1500),
        ),
      ]);
      await release?.();
      expect(outcome).toMatchObject({ ok: false, error: { code: "not-a-file" } });
    },
    10_000,
  );
});
