// V01-R17 (spec "T17이 넘기는 것" 2): the backend's entries never pass bootBackend's
// test-only replacements. The options stay in the production bundle (like `engine`
// and `vectorIndex`), so what keeps the product's Providers and embedder bound is
// that dev.ts and shell-main.ts (the body of shell.ts) hand bootBackend a literal object with neither key and
// nothing spread into it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SWAP_KEYS = ["providers", "embedder", "engine", "vectorIndex"] as const;

/** The literal object each `bootBackend({...})` call is given, braces balanced. */
function bootArguments(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/bootBackend\(\{/g)) {
    const start = (match.index ?? 0) + "bootBackend(".length;
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) {
        found.push(source.slice(start, i + 1));
        break;
      }
    }
  }
  return found;
}

function swapProblems(source: string): string[] {
  const calls = bootArguments(source);
  if (calls.length === 0) return ["no bootBackend({...}) call"];
  return calls.flatMap((arg) => [
    ...SWAP_KEYS.filter((k) => new RegExp(`\\b${k}\\b\\s*[:,}]`).test(arg)).map(
      (k) => `passes ${k}`,
    ),
    ...(arg.includes("...") ? ["spreads into the options"] : []),
  ]);
}

describe("entries pass no swap option (V01-R17)", () => {
  it.each(["dev.ts", "shell-main.ts"])("%s", (file) => {
    const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
    expect(swapProblems(source)).toEqual([]);
  });

  it("fails for an entry passing a replacement or spreading options in", () => {
    expect(swapProblems("await bootBackend({ dataDir, providers: [], token });")).toEqual([
      "passes providers",
    ]);
    expect(swapProblems("await bootBackend({ dataDir, embedder });")).toEqual(["passes embedder"]);
    expect(swapProblems("await bootBackend({ dataDir, ...extra });")).toEqual([
      "spreads into the options",
    ]);
  });
});
