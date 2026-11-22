// Every `@pki/*` package a workspace package declares must also be a tsconfig
// project reference. Without it, incremental `tsc -b` (pnpm typecheck) does not
// rebuild the dependent when the dependency changes, and type drift passes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceDirs } from "./packages.ts";

const REAL_ROOT = resolve(import.meta.dirname, "../..");

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** `root` is an argument (I05-R25): a fork's packages are read where they exist and skipped where they do not. */
function missingReferences(root: string): string[] {
  const dirs = workspaceDirs(root);
  const dirOf = new Map(dirs.map((d) => [readJson(join(root, d, "package.json")).name, d]));
  return dirs.flatMap((dir) => {
    const pkg = readJson(join(root, dir, "package.json"));
    const declared = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    }).filter((n) => n.startsWith("@pki/") || n.startsWith("@pki-site/"));
    const refs = new Set(
      (readJson(join(root, dir, "tsconfig.json")).references ?? []).map((r: { path: string }) =>
        relative(root, resolve(root, dir, r.path)),
      ),
    );
    return declared
      .filter((name) => !refs.has(dirOf.get(name) ?? name))
      .map((name) => `${dir} declares ${name} without a tsconfig reference`);
  });
}

describe("tsconfig project references", () => {
  it("finds the workspace packages", () => {
    expect(workspaceDirs(REAL_ROOT)).toEqual(
      expect.arrayContaining(["storage", "packages/testkit", "packages/site-example"]),
    );
  });

  it("references every declared @pki/* dependency", () => {
    expect(missingReferences(REAL_ROOT)).toEqual([]);
  });

  describe("on a temporary root (I05-C3 ②, C20 ②)", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "pki-refs-"));
      write(
        "pnpm-workspace.yaml",
        "packages:\n  - backend\n  - site/composition\n  - site/connectors/*\n",
      );
      pkg("backend", { name: "@pki/backend" }, {});
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));
    function write(rel: string, text: string) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    function pkg(dir: string, manifest: object, tsconfig: object) {
      write(`${dir}/package.json`, JSON.stringify(manifest));
      write(`${dir}/tsconfig.json`, JSON.stringify(tsconfig));
    }

    it("does not throw where the parent folder of a glob does not exist, and finds nothing wrong", () => {
      expect(workspaceDirs(root)).toEqual(["backend"]);
      expect(missingReferences(root)).toEqual([]);
    });

    it("does not throw where `site/` holds only the notice", () => {
      write("site/README.md", "notice");
      expect(missingReferences(root)).toEqual([]);
    });

    it("looks at a fork package's own dependencies once it exists: a missing reference to a public or a fork package fails", () => {
      pkg("site/connectors/x", { name: "@pki-site/connector-x" }, {});
      pkg(
        "site/composition",
        {
          name: "@pki-site/composition",
          dependencies: { "@pki/backend": "workspace:*", "@pki-site/connector-x": "workspace:*" },
        },
        { references: [{ path: "../../backend" }] },
      );
      expect(missingReferences(root)).toEqual([
        "site/composition declares @pki-site/connector-x without a tsconfig reference",
      ]);
      pkg(
        "site/composition",
        {
          name: "@pki-site/composition",
          dependencies: { "@pki/backend": "workspace:*", "@pki-site/connector-x": "workspace:*" },
        },
        { references: [{ path: "../../backend" }, { path: "../connectors/x" }] },
      );
      expect(missingReferences(root)).toEqual([]);
    });
  });
});
