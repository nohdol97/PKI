// I07-C8 `build.scopes-check` (I07-R7, R8): the build's judgment of the scopes file, on temporary roots only
// (I05-R25: no test writes under the real repository root). The judgment is a pure function of the root,
// the bundled entry and the bundle's module list, so every end of the decision diagram is reached by
// giving it those three. A duplicate key reaches it as raw text: a parsed object has lost it.
import { EXAMPLE_SCOPE_MARKER } from "@pki/contracts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  judgeConnectorScopes,
  requireConnectorScopes,
  type ScopesVerdict,
} from "./scopes-check.ts";

const REAL_ROOT = resolve(import.meta.dirname, "../../..");
const ALLOWED = "site/config/connector-scopes.json";
const EXAMPLE_FILE = "packages/site-example/config/connector-scopes.json";
const PUBLIC_ENTRY = "backend/src/shell.ts";
const FORK_ENTRY = "site/composition/src/shell.ts";
const EXAMPLE_ENTRY = "packages/site-example/src/shell.ts";

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "pki-scopes-check-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const judge = (entry: string, modules: string[]): ScopesVerdict =>
  judgeConnectorScopes(root, join(root, entry), modules);
const failure = (verdict: ScopesVerdict) => (verdict.ok ? "passed" : verdict.code);

describe("build.scopes-check: the decision diagram's seven ends (I07-C8)", () => {
  it("① a scopes file outside the allowed place in the module list is scopes-file-misplaced, with or without the allowed one beside it", () => {
    write("site/composition/config/connector-scopes.json", '{"a":["x"]}');
    expect(failure(judge(FORK_ENTRY, ["site/composition/config/connector-scopes.json"]))).toBe(
      "scopes-file-misplaced",
    );
    // the fork's entry taking the example's file in
    expect(failure(judge(FORK_ENTRY, [EXAMPLE_FILE]))).toBe("scopes-file-misplaced");
    // a good file at the allowed place, bound, does not rescue it
    write(ALLOWED, '{"a":["x"]}');
    expect(
      failure(judge(FORK_ENTRY, [ALLOWED, "site/composition/config/connector-scopes.json"])),
    ).toBe("scopes-file-misplaced");
    // the name is judged by its ending, whatever precedes it
    expect(failure(judge(PUBLIC_ENTRY, ["backend/src/other-connector-scopes.json"]))).toBe(
      "scopes-file-misplaced",
    );
  });

  it("② no file at the allowed place and none in the list is absent, with no entries", () => {
    const verdict = judge(FORK_ENTRY, ["site/composition/src/shell.ts"]);
    expect(verdict).toEqual({ ok: true, state: "absent", entries: 0, configured: 0 });
    expect(judge(PUBLIC_ENTRY, [])).toMatchObject({ ok: true, state: "absent" });
  });

  it("③ a file at the allowed place that the list lacks is scopes-file-unbound, in a root without a composition package and in one with it", () => {
    write(ALLOWED, '{"a":["x"]}');
    expect(failure(judge(PUBLIC_ENTRY, ["backend/src/shell.ts"]))).toBe("scopes-file-unbound");
    write("site/composition/package.json", "{}");
    write("site/composition/src/shell.ts", "");
    expect(failure(judge(FORK_ENTRY, ["site/composition/src/registration.ts"]))).toBe(
      "scopes-file-unbound",
    );
  });

  it.each<[string, string]>([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"x"'],
    ["a number", "7"],
    ["text that is not JSON", "{ not json"],
    ["an empty file", ""],
    ["an entry that is a string", '{"a":"x"}'],
    ["an entry with an empty string in its array", '{"a":["x",""]}'],
    ["an entry with a number in its array", '{"a":[1]}'],
    ["an entry that is an object", '{"a":{"b":["x"]}}'],
    ["a key __proto__", '{"__proto__":["x"]}'],
    ["a key __proto__ spelled with an escape", '{"__pro\\u0074o__":["x"]}'],
    ["the same key twice", '{"a":["x"],"a":["y"]}'],
    ["the same key twice, the second with an escape", '{"a":["x"],"\\u0061":["y"]}'],
    ["the same key twice, with others between", '{"a":["x"],"b":null,"c":["z"],"a":null}'],
  ])("④ %s is scopes-file-invalid", (_name, text) => {
    write(ALLOWED, text);
    expect(failure(judge(FORK_ENTRY, [ALLOWED]))).toBe("scopes-file-invalid");
  });

  it("④ keys that only look alike are not duplicates: the same text as a value, a different case", () => {
    write(ALLOWED, '{"a":["a"],"A":["a"],"b":null}');
    expect(failure(judge(FORK_ENTRY, [ALLOWED]))).toBe("passed");
  });

  it("⑤ the example marker among the values is scopes-file-placeholder", () => {
    write(ALLOWED, `{"a":["x","${EXAMPLE_SCOPE_MARKER}"],"b":null}`);
    expect(failure(judge(FORK_ENTRY, [ALLOWED]))).toBe("scopes-file-placeholder");
  });

  it.each(["{}", '{"a":null}', '{"a":null,"b":null}'])(
    "⑥ %s has no entry with a scope: empty, the entries counted",
    (text) => {
      write(ALLOWED, text);
      const verdict = judge(FORK_ENTRY, [ALLOWED]);
      expect(verdict).toMatchObject({ ok: true, state: "empty", configured: 0 });
      expect(verdict.ok && verdict.entries).toBe(Object.keys(JSON.parse(text)).length);
    },
  );

  it("⑦ anything else is bound, with the entry count and the count of entries that carry a scope", () => {
    write(ALLOWED, '{"a":["x","y"],"b":null,"c":["z"]}');
    expect(judge(FORK_ENTRY, [ALLOWED])).toEqual({
      ok: true,
      state: "bound",
      entries: 3,
      configured: 2,
    });
    // the public entry takes the same place
    expect(judge(PUBLIC_ENTRY, [ALLOWED])).toMatchObject({ state: "bound" });
  });

  it("the judgment reads only the allowed place of the root it is given: another root's file is not seen", () => {
    const other = mkdtempSync(join(tmpdir(), "pki-scopes-check-other-"));
    try {
      mkdirSync(join(other, "site/config"), { recursive: true });
      writeFileSync(join(other, ALLOWED), '{"a":["x"]}');
      expect(failure(judge(FORK_ENTRY, []))).toBe("passed");
      expect(judge(FORK_ENTRY, [])).toMatchObject({ state: "absent" });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("the verdict of a failure names its code and the place, and never a value", () => {
    write(ALLOWED, '{"secret-instance":"secret-scope"}');
    const verdict = judge(FORK_ENTRY, [ALLOWED]);
    expect(verdict.ok).toBe(false);
    const message = verdict.ok ? "" : verdict.message;
    expect(message).toContain("scopes-file-invalid");
    expect(message).toContain(ALLOWED);
    expect(message).not.toContain("secret-scope");
    expect(message).not.toContain("secret-instance");
  });
});

describe("build.scopes-check: the example entry's own place (I07-C8 ⑧)", () => {
  it("takes the example package's file as allowed and, holding the example marker, is scopes-file-placeholder rather than misplaced", () => {
    write(EXAMPLE_FILE, `{"example-import":["${EXAMPLE_SCOPE_MARKER}"]}`);
    expect(failure(judge(EXAMPLE_ENTRY, [EXAMPLE_FILE]))).toBe("scopes-file-placeholder");
  });

  it("does not allow the fork's place for the example entry, and an unbound example file is unbound", () => {
    write(ALLOWED, '{"a":["x"]}');
    expect(failure(judge(EXAMPLE_ENTRY, [ALLOWED]))).toBe("scopes-file-misplaced");
    rmSync(join(root, ALLOWED));
    write(EXAMPLE_FILE, '{"a":["x"]}');
    expect(failure(judge(EXAMPLE_ENTRY, []))).toBe("scopes-file-unbound");
  });

  it("the real example package's file is well formed and carries the example marker", () => {
    const text = readFileSync(join(REAL_ROOT, EXAMPLE_FILE), "utf8");
    const parsed = JSON.parse(text) as Record<string, string[]>;
    expect(Object.values(parsed).flat()).toContain(EXAMPLE_SCOPE_MARKER);
    expect(Object.keys(parsed)).toContain("example-import");
  });
});

describe("build.scopes-check: what the build does with the verdict (I07-R7)", () => {
  it("a failing verdict stops the build with its message, and a passing one gives the report's part", () => {
    write(ALLOWED, '{"a":["x"],"b":null}');
    expect(() => requireConnectorScopes(root, join(root, FORK_ENTRY), [])).toThrow(
      /scopes-file-unbound/,
    );
    expect(requireConnectorScopes(root, join(root, FORK_ENTRY), [ALLOWED])).toEqual({
      state: "bound",
      entries: 2,
      configured: 1,
    });
  });
});

describe("build.scopes-check: edges of the judgment", () => {
  it("a module that only ends with the allowed place is misplaced, not absent: the place is matched whole", () => {
    expect(failure(judge(FORK_ENTRY, ["packages/x/site/config/connector-scopes.json"]))).toBe(
      "scopes-file-misplaced",
    );
  });

  it("the marker is compared exactly: a value that merely contains it, or another case, is a real value", () => {
    write(
      ALLOWED,
      `{"a":["${EXAMPLE_SCOPE_MARKER}-team"],"b":["${EXAMPLE_SCOPE_MARKER.toUpperCase()}"]}`,
    );
    expect(judge(FORK_ENTRY, [ALLOWED])).toMatchObject({ ok: true, state: "bound" });
  });

  it("an invalid entry is judged before the placeholder (the diagram's order)", () => {
    write(ALLOWED, `{"a":["${EXAMPLE_SCOPE_MARKER}"],"b":"bad"}`);
    expect(failure(judge(FORK_ENTRY, [ALLOWED]))).toBe("scopes-file-invalid");
  });

  it("a key holding an escaped quote is judged like any other, not thrown on", () => {
    write(ALLOWED, '{"a\\"b":["x"],"c":["y"]}');
    expect(judge(FORK_ENTRY, [ALLOWED])).toMatchObject({ ok: true, state: "bound", entries: 2 });
    write(ALLOWED, '{"a\\"b":["x"],"a\\"b":["y"]}');
    expect(failure(judge(FORK_ENTRY, [ALLOWED]))).toBe("scopes-file-invalid");
  });

  it("a relative entry is refused rather than resolved against the working directory", () => {
    expect(() => judgeConnectorScopes(root, FORK_ENTRY, [])).toThrow(/absolute/);
  });
});

describe("build.scopes-check: the build takes the verdict without swallowing it", () => {
  it("build.ts calls the judgment step and has no try or catch that could turn its error into a passing build", () => {
    const build = readFileSync(join(REAL_ROOT, "apps/desktop/build/build.ts"), "utf8");
    expect(build).toContain("requireConnectorScopes(");
    expect(build).not.toMatch(/\b(try|catch)\b/);
  });
});
