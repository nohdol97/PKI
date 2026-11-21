// Keeps workspace packages behind their public entries (ADR 0001, V01-R1):
// a file may reach another workspace package only by its bare package name,
// and only if its own package.json declares that package as a dependency.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SCOPE = "@pki/";

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

/** @param {string} root @returns {Set<string>} */
function declaredDependencies(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
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
    },
  },
  create(context) {
    const ownRoot = packageRootOf(context.filename);
    if (!ownRoot) return {};

    /** @param {{ type: string; value?: unknown } | null | undefined} node */
    function check(node) {
      if (!node || node.type !== "Literal" || typeof node.value !== "string") return;
      const source = node.value;
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
      } else if (!declaredDependencies(/** @type {string} */ (ownRoot)).has(name)) {
        context.report({ node, messageId: "undeclaredDependency", data: { name } });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
    };
  },
};

export default moduleBoundary;
