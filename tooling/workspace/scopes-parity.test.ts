// I07-T03 drift guard: the build's rule for the scopes file (apps/desktop/build/scopes-check.ts) is written
// apart from the backend's `bindConnectorScopes` (backend/src/connector-scopes.ts), because @pki/desktop cannot
// import @pki/backend. One table of file texts goes through both, loaded by path in a child process as
// fork-shape.test.ts loads the other packages' code. Whatever the build passes, the backend must read
// the same way: the same state and counts, nothing rejected. The other way round (the build fails what the
// backend would accept) is the loud direction and is allowed: `__proto__`, a duplicate key, the example marker.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");

const TEXTS: string[] = [
  "{}",
  '{"a":null}',
  '{"a":null,"b":null}',
  '{"a":[]}',
  '{"a":["x"]}',
  '{"a":["x","x"]}',
  '{"a":["y","x"],"b":null}',
  '{"a":[" "]}',
  '{"1":["x"],"01":["y"]}',
  '{"":["x"]}',
  '{"constructor":["x"]}',
  '{"a\\"b":["x"]}',
  '{"a":["}{\\"a\\":"],"b":["{"]}',
  '{"a":["a"],"A":["a"]}',
  '  {"a":["x"]}\n',
  '{"a":["pki-example-scope-team"]}',
  '{"__proto__":["x"]}',
  '{"a":["x"],"a":["y"]}',
  '{"a":["pki-example-scope"]}',
  '{"a":["x"],"b":"bad"}',
  '{"a":[1]}',
  '{"a":["x",""]}',
  '{"a":{"b":["x"]}}',
  '["x"]',
  "null",
  "7",
  "true",
  '"x"',
];

interface Outcome {
  build: { ok: boolean; state?: string; entries?: number; configured?: number };
  boot: { state: string; entries: number; configured: number; rejected: number } | null;
}

function runBoth(): Outcome[] {
  const judge = pathToFileURL(resolve(REPO, "apps/desktop/build/scopes-check.ts")).href;
  const bind = pathToFileURL(resolve(REPO, "backend/src/connector-scopes.ts")).href;
  const script = `
    import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const { judgeConnectorScopes } = await import(${JSON.stringify(judge)});
    const { bindConnectorScopes } = await import(${JSON.stringify(bind)});
    const place = "site/config/connector-scopes.json";
    const out = [];
    for (const text of ${JSON.stringify(TEXTS)}) {
      const root = mkdtempSync(join(tmpdir(), "pki-scopes-parity-"));
      try {
        mkdirSync(join(root, "site/config"), { recursive: true });
        writeFileSync(join(root, place), text);
        const v = judgeConnectorScopes(root, join(root, "site/composition/src/shell.ts"), [place]);
        let boot = null;
        try {
          const b = bindConnectorScopes(JSON.parse(text));
          boot = { state: b.state, entries: b.entries, configured: b.configured, rejected: b.rejected };
        } catch {}
        out.push({ build: v.ok ? { ok: true, state: v.state, entries: v.entries, configured: v.configured } : { ok: false }, boot });
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    console.log(JSON.stringify(out));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }),
  ) as Outcome[];
}

describe("scopes-parity: the build's rule and the backend's agree where the build passes", () => {
  it("every text the build passes is read the same way by the backend, with nothing rejected", () => {
    const outcomes = runBoth();
    expect(outcomes).toHaveLength(TEXTS.length);
    const passed = outcomes.flatMap((o, i) => (o.build.ok ? [{ text: TEXTS[i], ...o }] : []));
    // the table holds passing and failing inputs both, so neither side can be vacuous
    expect(passed.length).toBeGreaterThan(10);
    expect(outcomes.length - passed.length).toBeGreaterThan(8);
    for (const { text, build, boot } of passed) {
      expect(boot, text).toEqual({
        state: build.state,
        entries: build.entries,
        configured: build.configured,
        rejected: 0,
      });
    }
  }, 60_000);
});
