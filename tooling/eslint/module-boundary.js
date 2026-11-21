// Keeps workspace packages behind their public entries (ADR 0001, V01-R1):
// a file may reach another workspace package only by its bare package name,
// and only if its own package.json declares that package as a dependency.
// A package declared only in devDependencies (test code such as @pki/testkit)
// may be imported only from test files, so it cannot reach production builds (V01-R20).
// Known gaps (not checked):
// - createRequire(import.meta.url)("...") calls
// - package.json "imports" subpaths ("#name")
// - absolute-path specifiers
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SCOPE = "@pki/";
const TEST_FILE = /\.(test|e2e)\.tsx?$/;

/** @param {string} file */
function packageRootOf(file) {
  let dir = dirname(file);
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return dir;
}

/** @param {string} root @returns {{ runtime: Set<string>, dev: Set<string> }} */
function declaredDependencies(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return {
    runtime: new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]),
    dev: new Set(Object.keys(manifest.devDependencies ?? {})),
  };
}

/** @type {import("eslint").Rule.RuleModule} */
const moduleBoundary = {
  meta: {
    type: "problem",
    docs: { description: "Forbid imports that bypass another workspace package's public entry" },
    schema: [],
    messages: {
      crossPackageRelative:
        "'{{source}}' reaches into another package by path; import its package name instead.",
      deepImport: "'{{source}}' bypasses the public entry of '{{name}}'; import '{{name}}' itself.",
      undeclaredDependency: "'{{name}}' is not a declared dependency of this package.",
      devOnlyDependency:
        "'{{name}}' is only a devDependency of this package; import it from test files only.",
    },
  },
  create(context) {
    const ownRoot = packageRootOf(context.filename);
    if (!ownRoot) return {};

    /** @param {any} node A Literal, or an expression-free TemplateLiteral */
    function check(node) {
      let source;
      if (node?.type === "Literal" && typeof node.value === "string") source = node.value;
      else if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
        source = node.quasis[0]?.value.cooked;
      }
      if (typeof source !== "string") return;
      if (source.startsWith(".")) {
        // Treat the target as a directory so a specifier naming a package root resolves to it.
        const target = join(resolve(dirname(context.filename), source), "_");
        if (packageRootOf(target) !== ownRoot) {
          context.report({ node, messageId: "crossPackageRelative", data: { source } });
        }
        return;
      }
      if (!source.startsWith(SCOPE)) return;
      const name = source.split("/").slice(0, 2).join("/");
      if (name !== source) {
        context.report({ node, messageId: "deepImport", data: { source, name } });
      } else {
        const { runtime, dev } = declaredDependencies(/** @type {string} */ (ownRoot));
        if (runtime.has(name)) return;
        if (!dev.has(name)) {
          context.report({ node, messageId: "undeclaredDependency", data: { name } });
        } else if (!TEST_FILE.test(context.filename)) {
          context.report({ node, messageId: "devOnlyDependency", data: { name } });
        }
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      // `typeof import("...")` in TypeScript type positions
      /** @param {any} node */
      TSImportType: (node) => check(node.argument?.literal),
    };
  },
};

export default moduleBoundary;
