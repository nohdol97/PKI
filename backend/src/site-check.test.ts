// V01-H2 `site-check`: for each site Connector kind the command prints the follow-up notice and
// exits non-zero (one test per kind, three in all), and I05-C18, C20 ① (I05-R19, R25): in a tree
// that has a composition package the public command points at the fork's command instead. The
// decisions run in-process on a temporary root (never the real repository root, so a fork-shaped
// checkout gives the same results): the repository root is an argument.
import {
  CONNECTOR_SDK_VERSION,
  ConnectorCredentialError,
  type Connector,
  type ConnectorContext,
} from "@pki/contracts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  publicSiteCheck,
  runSiteCheck,
  siteCheckGuidance,
  type SiteCheckIo,
} from "./site-check-main.ts";
import { connectorKinds } from "./composition.ts";
import { siteCheck } from "./connectors.ts";
import { publicSite, type SiteRegistration } from "./site-registration.ts";

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "pki-site-check-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function capture() {
  const seen = {
    stdout: [] as string[],
    stderr: [] as string[],
    code: undefined as number | undefined,
  };
  const io: SiteCheckIo = {
    stdout: (line) => seen.stdout.push(line),
    stderr: (line) => seen.stderr.push(line),
    exitCode: (code) => (seen.code = code),
  };
  return { io, seen };
}
const composition = (packageJson?: string) => {
  mkdirSync(join(root, "site/composition"), { recursive: true });
  if (packageJson !== undefined)
    writeFileSync(join(root, "site/composition/package.json"), packageJson);
};

describe("site-check in a tree with no composition package (V01-H2, I05-C20 ①)", () => {
  it.each(["site-mail", "site-messenger", "site-wiki"])(
    "%s prints the notice and exits non-zero",
    async (kind) => {
      const { io, seen } = capture();
      await publicSiteCheck(root, [kind], io);
      expect(seen.stderr).toEqual([`${kind}: 미구현, 배포처 후속`]);
      expect(seen.stdout).toEqual([]);
      expect(seen.code).toBe(1);
    },
  );

  it("rejects an unknown kind with usage and a distinct exit code", async () => {
    const { io, seen } = capture();
    await publicSiteCheck(root, ["site-nope"], io);
    expect(seen.stderr[0]).toMatch(/^usage: site-check <site-mail\|site-messenger\|site-wiki\|local-files>/);
    expect(seen.code).toBe(2);
  });

  it("the shapes with no composition package give the same answer: only a notice under site/, and site/connectors alone", async () => {
    mkdirSync(join(root, "site"), { recursive: true });
    writeFileSync(join(root, "site/README.md"), "notice only");
    expect(siteCheckGuidance(root)).toBeUndefined();
    mkdirSync(join(root, "site/connectors/x"), { recursive: true });
    expect(siteCheckGuidance(root)).toBeUndefined();
    const { io, seen } = capture();
    await publicSiteCheck(root, ["site-mail"], io);
    expect(seen.stderr).toEqual(["site-mail: 미구현, 배포처 후속"]);
    expect(seen.code).toBe(1);
  });
});

describe("site-check in a tree that has a composition package (I05-C18, R19)", () => {
  it("① names the fork's command from the package's own name and exits 2", async () => {
    composition(JSON.stringify({ name: "@acme-site/composition" }));
    const { io, seen } = capture();
    await publicSiteCheck(root, ["site-mail"], io);
    expect(seen.code).toBe(2);
    expect(seen.stdout).toEqual([]);
    expect(seen.stderr.join("\n")).toContain(
      "pnpm --filter @acme-site/composition site-check <종류>",
    );
    // not the placeholder's result
    expect(seen.stderr.join("\n")).not.toContain("미구현");
  });

  it("accepts an unscoped package name", () => {
    composition(JSON.stringify({ name: "acme-composition" }));
    expect(siteCheckGuidance(root)).toContain("pnpm --filter acme-composition site-check <종류>");
  });

  it.each([
    ["no name", JSON.stringify({ version: "1.0.0" })],
    ["a name that is not a string", JSON.stringify({ name: 7 })],
    ["a name that is not package-shaped", JSON.stringify({ name: "$(touch /tmp/x) ; rm" })],
    ["an empty name", JSON.stringify({ name: "" })],
    ["a file that is not JSON", "{ not json"],
    ["an array", "[]"],
  ])("② %s: the guidance names no package and still exits 2", async (_label, text) => {
    composition(text);
    const guidance = siteCheckGuidance(root) as string;
    expect(guidance).toContain("site/composition");
    expect(guidance).toContain("site-check");
    expect(guidance).not.toContain("--filter");
    expect(guidance).not.toContain("touch");
    const { io, seen } = capture();
    await publicSiteCheck(root, [], io);
    expect(seen.code).toBe(2);
  });

  it("a composition folder with no package.json is not a composition package", () => {
    composition();
    expect(siteCheckGuidance(root)).toBeUndefined();
  });
});

describe("runSiteCheck (I05-R1): the fork's own entry checks the registration's kinds", () => {
  const connector: Connector = {
    manifest: {
      type: "fork",
      schemaVersion: CONNECTOR_SDK_VERSION,
      capabilities: {
        incremental: false,
        deletes: false,
        accessScope: false,
        fullRescan: false,
        deletionsOnRescan: false,
      },
    },
    initialize: async () => {},
    healthCheck: async () => ({ state: "ok" }),
    getChanges: async () => ({ changes: [], nextCursor: "0", hasMore: false }),
    getDocument: async () => null,
  };

  it("a registered kind is checked and reported ok, with exit code unchanged", async () => {
    const { io, seen } = capture();
    await runSiteCheck({ connectorKinds: { fork: () => connector } }, ["fork"], io);
    expect(seen.stdout).toEqual(["fork: ok"]);
    expect(seen.stderr).toEqual([]);
    expect(seen.code).toBeUndefined();
  });

  it("the usage lists the registered kinds next to the product's", async () => {
    const { io, seen } = capture();
    await runSiteCheck({ connectorKinds: { fork: () => connector } }, ["nope"], io);
    expect(seen.stderr[0]).toBe("usage: site-check <site-mail|site-messenger|site-wiki|local-files|fork>");
    expect(seen.code).toBe(2);
  });

  it("a placeholder the registration replaced is the registration's; the others still fail with the notice (I05-H2)", async () => {
    const { io, seen } = capture();
    await runSiteCheck(
      {
        connectorKinds: {
          "site-mail": () => ({
            ...connector,
            manifest: { ...connector.manifest, type: "site-mail" },
          }),
        },
      },
      ["site-mail"],
      io,
    );
    expect(seen.stdout).toEqual(["site-mail: ok"]);
    const second = capture();
    await runSiteCheck({}, ["site-wiki"], second.io);
    expect(second.seen.stderr).toEqual(["site-wiki: 미구현, 배포처 후속"]);
    expect(second.seen.code).toBe(1);
  });

  it.each(["site-mail", "site-messenger", "site-wiki"])(
    "I05-H2: the empty registration's %s is not implemented and the exit is not zero",
    async (kind) => {
      const { io, seen } = capture();
      await runSiteCheck(publicSite, [kind], io);
      expect(seen.stderr).toEqual([`${kind}: 미구현, 배포처 후속`]);
      expect(seen.code).toBe(1);
    },
  );

  it("a registration that boot would refuse is not reported ok: the stopping codes and counts, exit 1 (security review W3)", async () => {
    const { io, seen } = capture();
    await runSiteCheck(
      {
        connectorKinds: { fork: () => connector },
        connectorInstances: [
          { id: "fixtures", kind: "fork", config: {} },
          { id: "b", kind: "jsonl-import", config: {} },
        ],
      },
      ["fork"],
      io,
    );
    expect(seen.stdout).toEqual([]);
    expect(seen.stderr).toEqual([
      "site-registration-invalid instance-kind-reserved=1 instance-id-reserved=1",
    ]);
    expect(seen.code).toBe(1);
  });

  it("a registration with only dropped items is still checked as before", async () => {
    const { io, seen } = capture();
    await runSiteCheck(
      { connectorKinds: { fork: () => connector, Bad: () => connector } },
      ["fork"],
      io,
    );
    expect(seen.stdout).toEqual(["fork: ok"]);
    expect(seen.code).toBeUndefined();
  });

  it("a kind whose name a public kind holds is not a site-check target", async () => {
    const { io, seen } = capture();
    await runSiteCheck(publicSite, ["test-fixtures"], io);
    expect(seen.code).toBe(2);
  });
});

describe("the entry script", () => {
  const script = resolve(import.meta.dirname, "site-check.ts");
  const run = (kind: string) => spawnSync(process.execPath, [script, kind], { encoding: "utf8" });

  it("is wired to the decision: an unknown kind exits 2 in either shape of the checkout", () => {
    expect(run("site-nope").status).toBe(2);
  });

  it("passes the kind argument on: a placeholder kind is neither a usage error nor a pass, in either shape (R25)", () => {
    const result = run("site-mail");
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toMatch(/^usage:/);
    expect(result.stderr).toMatch(/미구현, 배포처 후속|site\/composition/);
  });

  it("takes the repository root two folders above itself and the arguments after the script", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toContain('resolve(import.meta.dirname, "../..")');
    expect(text).toContain("process.argv.slice(2)");
  });
});

describe("site-check --scopes (I07-R6, I07-C7, I07-H2 ①)", () => {
  const SCOPE = "synthetic-scope-marker-ffff";
  const ID = "synthetic-instance-marker-gggg";
  const run = async (site: SiteRegistration, args: string[] = ["--scopes"]) => {
    const { io, seen } = capture();
    await runSiteCheck(site, args, io);
    return seen;
  };
  const every = (seen: { stdout: string[]; stderr: string[] }) =>
    [...seen.stdout, ...seen.stderr].join("\n");

  it("no field (H2 ①: the empty registration): not implemented, points at S30, the exit is not zero", async () => {
    for (const site of [publicSite, {}]) {
      const seen = await run(site);
      expect(seen.stdout).toEqual([]);
      expect(seen.stderr).toHaveLength(1);
      expect(seen.stderr[0]).toContain("미구현, 배포처 후속");
      expect(seen.stderr[0]).toContain("S30");
      expect(seen.code).toBe(1);
    }
  });

  it("not an object, or an entry that is not well-formed: the state and the count, the exit is not zero", async () => {
    const field = await run({ connectorScopes: [SCOPE] });
    expect(field.stderr).toEqual([expect.stringContaining("connector-scopes-field-invalid")]);
    expect(field.code).toBe(1);
    const entries = await run({ connectorScopes: { [ID]: "x", b: [1], c: [SCOPE] } });
    expect(entries.stderr).toEqual([expect.stringContaining("틀린 항목 2개")]);
    expect(entries.stderr[0]).toContain("connector-scopes-entry-invalid");
    expect(entries.code).toBe(1);
  });

  it("a sparse array entry is a refused entry: not zero", async () => {
    // eslint-disable-next-line no-sparse-arrays
    const seen = await run({ connectorScopes: { a: [, SCOPE], b: [SCOPE] } });
    expect(seen.stderr).toEqual([expect.stringContaining("틀린 항목 1개")]);
    expect(seen.code).toBe(1);
  });

  it("the example marker is still in the value: told, the exit is not zero (also next to another scope)", async () => {
    for (const connectorScopes of [
      { [ID]: ["pki-example-scope"] },
      { [ID]: [SCOPE, "pki-example-scope"], other: [SCOPE] },
    ]) {
      const seen = await run({ connectorScopes });
      expect(seen.stderr).toEqual([expect.stringContaining("예시 값이 그대로다")]);
      expect(seen.code).toBe(1);
    }
  });

  it("no entry with a scope (an empty object, all null): told, the exit is not zero", async () => {
    for (const connectorScopes of [{}, { [ID]: null, b: null }]) {
      const seen = await run({ connectorScopes });
      expect(seen.stderr).toEqual([expect.stringContaining("범위가 있는 항목이 없다")]);
      expect(seen.code).toBe(1);
    }
  });

  it("otherwise: the number of entries and of scoped entries, the exit is zero (unset)", async () => {
    const seen = await run({ connectorScopes: { [ID]: [SCOPE], b: null, c: [SCOPE, "x"] } });
    expect(seen.stdout).toEqual(["--scopes: 항목 3개, 범위가 있는 항목 2개"]);
    expect(seen.stderr).toEqual([]);
    expect(seen.code).toBeUndefined();
  });

  it("no output of any row holds a scope value or an instance id", async () => {
    for (const connectorScopes of [
      [SCOPE],
      { [ID]: "x", [SCOPE]: [SCOPE] },
      { [ID]: ["pki-example-scope", SCOPE] },
      { [ID]: null },
      { [ID]: [SCOPE] },
    ]) {
      const text = every(await run({ connectorScopes }));
      expect(text).not.toContain(SCOPE);
      expect(text).not.toContain(ID);
    }
  });

  it("without --scopes the kind cases are as before, and a kind named like the argument is no kind", async () => {
    const seen = await run({ connectorScopes: { a: [SCOPE] } }, ["site-mail"]);
    expect(seen.stderr).toEqual(["site-mail: 미구현, 배포처 후속"]);
    expect(seen.code).toBe(1);
    const usage = await run({}, ["scopes"]);
    expect(usage.code).toBe(2);
  });

  it("the public command in a tree with a composition package still points at the fork's command first", async () => {
    composition(JSON.stringify({ name: "@acme-site/composition" }));
    const { io, seen } = capture();
    await publicSiteCheck(root, ["--scopes"], io);
    expect(seen.code).toBe(2);
    expect(seen.stderr.join("\n")).toContain("@acme-site/composition");
  });
});

describe("site-check with the credential accessor (I06-R8, I06-C13, I06-H2)", () => {
  const CANARY = "synthetic-canary-value-0003";
  const credentialed = (initialize: (c: ConnectorContext) => Promise<void>): SiteRegistration => ({
    connectorKinds: {
      fork: () =>
        ({
          manifest: { type: "fork", schemaVersion: CONNECTOR_SDK_VERSION, capabilities: {} },
          initialize: (_config: unknown, context?: ConnectorContext) =>
            initialize(context as ConnectorContext),
          healthCheck: async () => ({ state: "ok" }),
          getChanges: async () => ({ changes: [], nextCursor: "0", hasMore: false }),
          getDocument: async () => null,
        }) as unknown as Connector,
    },
  });

  it("C13 a kind that reads a slot in initialize is ok (credential-required) with exit 0, and the error's own text is not printed", async () => {
    const { io, seen } = capture();
    await runSiteCheck(
      credentialed(async (c) => {
        await c.credentials.read("token"); // refused: the accessor of site-check reads nothing
        throw Object.assign(new ConnectorCredentialError(), { message: CANARY });
      }),
      ["fork"],
      io,
    );
    expect(seen.stdout).toEqual(["fork: ok (credential-required)"]);
    expect(seen.stderr).toEqual([]);
    expect(seen.code).toBeUndefined();
  });

  it("C13 a kind that does not read a slot is as before: ok, or the message of its failure", async () => {
    const ok = capture();
    await runSiteCheck(
      credentialed(async () => undefined),
      ["fork"],
      ok.io,
    );
    expect(ok.seen.stdout).toEqual(["fork: ok"]);
    const failed = capture();
    await runSiteCheck(
      credentialed(async () => Promise.reject(new Error("plain failure"))),
      ["fork"],
      failed.io,
    );
    expect(failed.seen.stderr).toEqual(["fork: plain failure"]);
    expect(failed.seen.code).toBe(1);
  });

  it.each(["site-mail", "site-messenger", "site-wiki"] as const)(
    "H2 %s is given the accessor and still reports 미구현, 배포처 후속 and fails",
    async (kind) => {
      let received: ConnectorContext | undefined;
      const outcome = await siteCheck(kind, () => {
        const connector = connectorKinds[kind]();
        const original = connector.initialize.bind(connector);
        connector.initialize = (config, context) => {
          received = context;
          return original(config, context);
        };
        return connector;
      });
      expect(received?.credentials).toBeDefined();
      expect(outcome).toEqual({ ok: false, line: `${kind}: 미구현, 배포처 후속` });
    },
  );
});
