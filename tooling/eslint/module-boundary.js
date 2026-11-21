// Keeps workspace packages behind their public entries (ADR 0001, V01-R1):
// a file may reach another workspace package only by its bare package name,
// and only if its own package.json declares that package as a dependency.
// A package declared only in devDependencies (test code such as @pki/testkit)
// may be imported only from test files, so it cannot reach production builds (V01-R20).
// Implementation boundary (V01-T07): adapter implementations live under a
// package's src/adapters/ and are reached only by the composition root
// (backend/src/composition.ts), through relative paths in its own package or a
// package's "<name>/adapters" entry. Any other module, a public entry re-exporting
// one included, fails. Test files may reach the implementation they test, and
// @pki/testkit (test doubles, test builds only) is outside this boundary. A class,
// function or value typed as an adapter interface outside src/adapters/ fails too,
// so an implementation cannot escape the boundary by living elsewhere.
// Known gaps (not checked):
// - createRequire(import.meta.url)("...") calls
// - package.json "imports" subpaths ("#name")
// - absolute-path specifiers
// - an implementation outside src/adapters/ whose return type is omitted or
//   wrapped (e.g. Promise<Connector>): it escapes the location check, and so
//   its importers are not checked either; review catches it
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SCOPE = "@pki/";
const TEST_FILE = /\.(test|e2e)\.tsx?$/;
const ADAPTERS_DIR = "src/adapters";
const COMPOSITION_ROOT = { pkg: "@pki/backend", file: "src/composition.ts" };
const EXEMPT_PACKAGES = new Set(["@pki/contracts", "@pki/testkit"]);
const ADAPTER_INTERFACES = new Set([
  "Connector",
  "EmbeddingProvider",
  "KnowledgeEngine",
  "LLMProvider",
  "OpenSqlDriver",
  "SqlDriver",
  "VectorIndex",
]);

/** @param {string} rel A path relative to its package root, with forward slashes */
const inAdapters = (rel) => rel === ADAPTERS_DIR || rel.startsWith(`${ADAPTERS_DIR}/`);

/** @param {any} type A TypeScript type node: its name when it names an adapter interface */
function adapterName(type) {
  const name = type?.type === "TSTypeReference" ? type.typeName?.name : undefined;
  return ADAPTER_INTERFACES.has(name) ? name : undefined;
}

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
      adapterImport:
        "'{{source}}' is an adapter implementation; only the composition root (backend/src/composition.ts) may import it.",
      adapterEntry:
        "'{{source}}' is an adapter implementation entry; only the composition root (backend/src/composition.ts) may import it.",
      adapterOutsideAdapters:
        "'{{name}}' is implemented outside src/adapters/; adapter implementations live there, behind the composition root.",
    },
  },
  create(context) {
    const ownRoot = packageRootOf(context.filename);
    if (!ownRoot) return {};
    const ownName = JSON.parse(readFileSync(join(ownRoot, "package.json"), "utf8")).name;
    const ownPath = relative(ownRoot, context.filename).split(sep).join("/");
    const isTest = TEST_FILE.test(context.filename);
    const isComposition = ownName === COMPOSITION_ROOT.pkg && ownPath === COMPOSITION_ROOT.file;
    // who may reach an implementation: the root, implementations themselves, tests
    const mayReachAdapters =
      isComposition || isTest || inAdapters(ownPath) || EXEMPT_PACKAGES.has(ownName);

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
        const resolved = resolve(dirname(context.filename), source);
        if (packageRootOf(join(resolved, "_")) !== ownRoot) {
          context.report({ node, messageId: "crossPackageRelative", data: { source } });
        } else if (
          !mayReachAdapters &&
          inAdapters(
            relative(/** @type {string} */ (ownRoot), resolved)
              .split(sep)
              .join("/"),
          )
        ) {
          context.report({ node, messageId: "adapterImport", data: { source } });
        }
        return;
      }
      if (!source.startsWith(SCOPE)) return;
      const name = source.split("/").slice(0, 2).join("/");
      const adaptersEntry = source === `${name}/adapters`;
      if (adaptersEntry && !isComposition && !isTest) {
        context.report({ node, messageId: "adapterEntry", data: { source } });
      } else if (name !== source && !adaptersEntry) {
        context.report({ node, messageId: "deepImport", data: { source, name } });
      } else {
        const { runtime, dev } = declaredDependencies(/** @type {string} */ (ownRoot));
        if (runtime.has(name)) return;
        if (!dev.has(name)) {
          context.report({ node, messageId: "undeclaredDependency", data: { name } });
        } else if (!isTest) {
          context.report({ node, messageId: "devOnlyDependency", data: { name } });
        }
      }
    }

    /** @param {any} node @param {string | undefined} name */
    function implementation(node, name) {
      if (name && !mayReachAdapters) {
        context.report({ node, messageId: "adapterOutsideAdapters", data: { name } });
      }
    }
    /** @param {any} node */
    const classImplements = (node) => {
      for (const clause of node.implements ?? []) {
        const name = clause.expression?.name;
        implementation(clause, ADAPTER_INTERFACES.has(name) ? name : undefined);
      }
    };
    /** @param {any} node */
    const returns = (node) => implementation(node, adapterName(node.returnType?.typeAnnotation));

    return {
      ClassDeclaration: classImplements,
      ClassExpression: classImplements,
      FunctionDeclaration: returns,
      FunctionExpression: returns,
      ArrowFunctionExpression: returns,
      /** @param {any} node */
      VariableDeclarator: (node) =>
        implementation(node, adapterName(node.id?.typeAnnotation?.typeAnnotation)),
      /** @param {any} node */
      TSSatisfiesExpression: (node) => implementation(node, adapterName(node.typeAnnotation)),
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
