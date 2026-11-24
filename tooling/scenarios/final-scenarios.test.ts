// H03-C3 (spec 2026-11-24-H03-C3-final-scenarios): the evidence table of the 14 final scenarios, its checker
// and the generated document. The checker takes the table and a "read file" function, so a broken table is a
// value in memory and no temporary folder is made (C2-C4); the repository's own table is read from disk (C1, C5).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FINAL_SCENARIOS,
  checkScenarioMap,
  renderScenarioDoc,
  runScenarioCheck,
} from "./final-scenarios.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const readFile = (path: string): string | undefined => {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return undefined;
  }
};
const repoMap = JSON.parse(readFile("eval/final-scenarios.json") as string);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A table that is right: 14 scenarios, one dev/mock unit test each, one blocker each. */
function goodMap(): Json {
  return {
    schemaVersion: 1,
    scenarios: FINAL_SCENARIOS.map(({ id, title }) => ({
      id,
      title,
      owners: ["X01"],
      status: "mock-only",
      evidence: [
        {
          kind: "unit",
          path: "a/b.test.ts",
          title: "does the thing",
          provider: "mock",
          environment: "dev",
        },
      ],
      blockers: [{ kind: "windows-installer", note: "설치본에서 돌린 적 없음" }],
    })),
  };
}
const fakeRead = (path: string) =>
  path === "playwright.config.ts"
    ? 'testIgnore: ["apps/desktop/**", "backend/src/v02-seed.e2e.ts"],'
    : path.endsWith(".test.ts") || path.endsWith(".e2e.ts")
      ? "it('does the thing')"
      : "x";
const scenario = (map: Json, id: string): Json => map.scenarios.find((s: Json) => s.id === id);
const mentions = (lines: string[], id: string) => lines.filter((l) => l.includes(id));

const SITE = "https://github.com/nohdol97/PKI/issues/20#issuecomment-123456";
const siteResult = (provider: string) => ({
  kind: "site-result",
  url: SITE,
  provider,
  environment: "windows-installer",
});

describe("H03C3-C1 the repository's table", () => {
  it("is clean on the real file system: 14 scenarios, none verified, each with a blocker", () => {
    expect(checkScenarioMap(repoMap, readFile)).toEqual([]);
    expect(repoMap.scenarios).toHaveLength(14);
    expect(repoMap.scenarios.filter((s: Json) => s.status === "verified")).toEqual([]);
    for (const s of repoMap.scenarios) expect(s.blockers.length, s.id).toBeGreaterThan(0);
  });
});

describe("H03C3-C2 a missing scenario or a title the file does not hold", () => {
  it("is clean for a right table", () => {
    expect(checkScenarioMap(goodMap(), fakeRead)).toEqual([]);
  });

  it("names the scenario that is left out and the one given twice", () => {
    const left = goodMap();
    left.scenarios = left.scenarios.filter((s: Json) => s.id !== "FS05");
    expect(mentions(checkScenarioMap(left, fakeRead), "FS05")).not.toEqual([]);
    const twice = goodMap();
    twice.scenarios.push(structuredClone(scenario(twice, "FS07")));
    expect(mentions(checkScenarioMap(twice, fakeRead), "FS07")).not.toEqual([]);
  });

  it("names the scenario whose test title is not in the file", () => {
    const map = goodMap();
    scenario(map, "FS09").evidence[0].title = "a title nobody wrote";
    expect(mentions(checkScenarioMap(map, fakeRead), "FS09")).not.toEqual([]);
    expect(mentions(checkScenarioMap(map, fakeRead), "FS08")).toEqual([]);
  });
});

describe("H03C3-C3 the vocabulary and the status conditions", () => {
  it("rejects a repository test that claims a real Provider or the installer", () => {
    for (const patch of [{ provider: "real" }, { environment: "windows-installer" }]) {
      const map = goodMap();
      Object.assign(scenario(map, "FS02").evidence[0], patch);
      expect(mentions(checkScenarioMap(map, fakeRead), "FS02"), JSON.stringify(patch)).not.toEqual(
        [],
      );
    }
  });

  it("rejects verified without a site-result and blockers left on a non-verified scenario empty", () => {
    const verified = goodMap();
    scenario(verified, "FS03").status = "verified";
    scenario(verified, "FS03").blockers = [];
    expect(mentions(checkScenarioMap(verified, fakeRead), "FS03")).not.toEqual([]);
    const bare = goodMap();
    scenario(bare, "FS04").blockers = [];
    expect(mentions(checkScenarioMap(bare, fakeRead), "FS04")).not.toEqual([]);
  });

  it("passes verified when installer and real-Provider site-results are there and nothing blocks", () => {
    const map = goodMap();
    const fs = scenario(map, "FS04");
    fs.status = "verified";
    fs.blockers = [];
    fs.evidence.push(siteResult("real"));
    expect(checkScenarioMap(map, fakeRead)).toEqual([]);
    // a Provider-calling scenario with only a mock installer result is not enough
    fs.evidence[fs.evidence.length - 1] = siteResult("mock");
    expect(mentions(checkScenarioMap(map, fakeRead), "FS04")).not.toEqual([]);
  });
});

describe("H03C3-C7 needsProvider is fixed in the checker", () => {
  it("rejects the key in the table, so a map cannot lower it for FS04", () => {
    const map = goodMap();
    const fs = scenario(map, "FS04");
    fs.needsProvider = false;
    fs.status = "verified";
    fs.blockers = [];
    fs.evidence.push(siteResult("mock"));
    const lines = mentions(checkScenarioMap(map, fakeRead), "FS04");
    expect(lines.some((l) => l.includes("needsProvider"))).toBe(true);
    expect(lines.some((l) => l.includes("verified needs"))).toBe(true);
  });
});

describe("H03C3-C8 evidence paths", () => {
  it("rejects a unit evidence under a folder vitest does not run, but not a measure under eval/results", () => {
    for (const path of ["eval/a.test.ts", "verification/a.test.ts", "x/node_modules/a.test.ts"]) {
      const map = goodMap();
      scenario(map, "FS06").evidence[0].path = path;
      expect(mentions(checkScenarioMap(map, fakeRead), "FS06"), path).not.toEqual([]);
    }
    const map = goodMap();
    scenario(map, "FS06").evidence.push({
      kind: "measure",
      path: "eval/results/a.json",
      provider: "none",
      environment: "dev",
    });
    expect(checkScenarioMap(map, fakeRead)).toEqual([]);
  });

  it("turns a directory path into a fault line naming the scenario, exit 1", () => {
    const map = goodMap();
    scenario(map, "FS10").evidence[0].path = "tooling";
    scenario(map, "FS11").blockers[0].procedure = "tooling";
    const out: string[] = [];
    const code = runScenarioCheck([], {
      loadMap: () => map,
      read: (path) => {
        if (path === "tooling") throw new Error("EISDIR: illegal operation on a directory, read");
        return fakeRead(path);
      },
      out: (line) => out.push(line),
      writeDoc: () => {},
    });
    expect(code).toBe(1);
    expect(mentions(out, "FS10")).not.toEqual([]);
    expect(mentions(out, "FS11")).not.toEqual([]);
  });

  it("rejects a Windows drive-absolute path and a backslash path", () => {
    for (const path of ["C:\\x\\a.test.ts", "C:/x/a.test.ts", "c:a.test.ts", "a\\b.test.ts"]) {
      const map = goodMap();
      scenario(map, "FS12").evidence[0].path = path;
      const lines = mentions(checkScenarioMap(map, fakeRead), "FS12");
      expect(
        lines.some((l) => l.includes("repository-relative")),
        path,
      ).toBe(true);
    }
  });
});

describe("H03C3-C4 the command", () => {
  const run = (map: unknown, args: string[] = []) => {
    const out: string[] = [];
    const code = runScenarioCheck(args, {
      loadMap: () => map,
      read: fakeRead,
      out: (line) => out.push(line),
      writeDoc: () => {},
    });
    return { code, text: out.join("\n") };
  };

  it("ends 0 with the blocker count, 2 under --release, and 1 for a broken table whatever the flag", () => {
    const ok = run(goodMap());
    expect(ok.code).toBe(0);
    expect(ok.text).toContain("차단 항목 14");
    expect(run(goodMap(), ["--release"]).code).toBe(2);
    const broken = goodMap();
    broken.scenarios.pop();
    expect(run(broken).code).toBe(1);
    expect(run(broken, ["--release"]).code).toBe(1);
  });
});

describe("H03C3-C5 the generated document", () => {
  it("is what the repository's table renders now, with all 14 ids", () => {
    const doc = renderScenarioDoc(repoMap);
    expect(readFile("docs/FINAL_SCENARIOS.md")).toBe(doc);
    for (const { id } of FINAL_SCENARIOS) expect(doc).toContain(id);
    expect(doc).toContain("대역 통과는 실제 동작의 증거가 아니다");
  });
});

describe("HVT (final-scenarios checker)", () => {
  it("HVT-C6: an e2e evidence the playwright config ignores by name is rejected; the repository's table stays clean", () => {
    const map = goodMap();
    scenario(map, "FS06").evidence[0] = {
      kind: "e2e",
      path: "backend/src/v02-seed.e2e.ts",
      title: "does the thing",
      provider: "mock",
      environment: "dev",
    };
    expect(mentions(checkScenarioMap(map, fakeRead), "FS06")).not.toEqual([]);
    expect(checkScenarioMap(repoMap, readFile)).toEqual([]);
  });

  it("HVT-C7: the folder rule follows vitest's exclude (root-only eval/, any-depth node_modules) without case", () => {
    const lines = (path: string) => {
      const map = goodMap();
      scenario(map, "FS06").evidence[0].path = path;
      return mentions(checkScenarioMap(map, fakeRead), "FS06");
    };
    expect(lines("x/eval/a.test.ts")).toEqual([]);
    expect(lines("Eval/a.test.ts")).not.toEqual([]);
    for (const path of ["eval/a.test.ts", "verification/a.test.ts", "x/node_modules/a.test.ts"])
      expect(lines(path), path).not.toEqual([]);
  });
});
