// V01-H2 `site-check`: for each site Connector kind the command prints the follow-up notice and
// exits non-zero (one test per kind, three in all), and I05-C18, C20 ① (I05-R19, R25): in a tree
// that has a composition package the public command points at the fork's command instead. The
// decisions run in-process on a temporary root (never the real repository root, so a fork-shaped
// checkout gives the same results): the repository root is an argument.
import { CONNECTOR_SDK_VERSION, type Connector } from "@pki/contracts";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  publicSiteCheck,
  runSiteCheck,
  siteCheckGuidance,
  type SiteCheckIo,
} from "./site-check-main.ts";
import { publicSite } from "./site-registration.ts";

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
    expect(seen.stderr[0]).toMatch(/^usage: site-check <site-mail\|site-messenger\|site-wiki>/);
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
    expect(seen.stderr[0]).toBe("usage: site-check <site-mail|site-messenger|site-wiki|fork>");
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

  it("a kind whose name a public kind holds is not a site-check target", async () => {
    const { io, seen } = capture();
    await runSiteCheck(publicSite, ["test-fixtures"], io);
    expect(seen.code).toBe(2);
  });
});

describe("the entry script", () => {
  it("is wired to the decision: an unknown kind exits 2 in either shape of the checkout", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "site-check.ts"), "site-nope"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
  });
});
