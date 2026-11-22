// Keeps workspace packages behind their public entries (ADR 0001, V01-R1):
// a file may reach another workspace package only by its bare package name,
// and only if its own package.json declares that package as a dependency.
// A package declared only in devDependencies (test code such as @pki/testkit)
// may be imported only from test files, so it cannot reach production builds (V01-R20).
// Implementation boundary (V01-T07): adapter implementations live under a
// package's src/adapters/ and are reached only by the composition root
// (backend/src/composition.ts), through relative paths in its own package or a
// package's "<name>/adapters" entry. Any other module fails, type-only imports
// and a public entry re-exporting one included. Test files may reach the
// implementation they test; product code may not import a test module (it could
// re-export an adapter). A test module is a `.test`/`.e2e` file or any file under a
// package's top-level e2e/ folder (E2E helpers such as launch.ts, V02-T11 A-F2). @pki/testkit (test doubles, test builds only) is outside
// this boundary. Outside src/adapters/, code that builds an implementation fails
// too: a class implementing an adapter interface, or an object, class, function
// or `new` value typed as one (annotation, return type, satisfies, as), including
// either branch of `?:`, `&&`, `||`, `??`, and a same-function `const` that the
// function returns. Names are followed through import aliases, qualified names,
// top-level type aliases and interfaces extending an adapter, unions,
// intersections, function and constructor types, a function's own type
// parameters constrained to an adapter, and the wrappers in WRAPPERS. Holding or
// returning a value built elsewhere (`const i: VectorIndex = deps.index`) is
// allowed, for a function value too (`const f: ConnectorFactory = () => existing`).
// Known gaps (not checked):
// - createRequire(import.meta.url)("...") calls
// - package.json "imports" subpaths ("#name")
// - absolute-path specifiers
// - import() with a computed specifier (import(`./adapters/${name}.ts`))
// - an implementation outside src/adapters/ that names no adapter type at all;
//   is built indirectly (a call's result such as Object.assign, array or Map
//   elements, array spread; a local declared with let/var, outside the function,
//   inside a nested block, by destructuring, or through a second local); is
//   typed through an alias or interface declared inside a function or in another
//   module (except ConnectorFactory), a container other than WRAPPERS, or a type
//   parameter of a class or a variable: it escapes, and so do its importers;
//   review catches it
//   Known and accepted: storage/src/canonical-transaction.ts builds a CanonicalTx
//   (an interface extending SqlDriver, declared in derivatives.ts) outside
//   src/adapters/. It is a delegating wrapper of the composition root's driver
//   that upper code must import (I04 spec, "T05가 넘기는 것" 9). Closing this
//   gap must exempt that file by name.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SCOPE = "@pki/";
const TEST_FILE = /\.(test|e2e)\.tsx?$/;
const ADAPTERS_DIR = "src/adapters";
const COMPOSITION_ROOT = { pkg: "@pki/backend", file: "src/composition.ts" };
const TEST_SPECIFIER = /\.(test|e2e)(\.[cm]?[jt]sx?)?$/;
/** A package's top-level e2e/ folder holds test code only, whatever the file names. */
const E2E_DIR = "e2e";

/** @param {string} path An absolute path @returns {boolean} */
function inE2eDir(path) {
  const root = packageRootOf(path);
  return root !== undefined && relative(root, path).split(sep)[0] === E2E_DIR;
}
const EXEMPT_PACKAGES = new Set(["@pki/testkit"]);
const ADAPTER_INTERFACES = new Set([
  "Connector",
  "ConnectorFactory",
  "EmbeddingProvider",
  "KnowledgeEngine",
  "LLMProvider",
  "OpenSqlDriver",
  "SqlDriver",
  "VectorIndex",
]);

/** @param {string} rel A path relative to its package root, with forward slashes */
const inAdapters = (rel) => rel === ADAPTERS_DIR || rel.startsWith(`${ADAPTERS_DIR}/`);

// Generic types whose value is (a promise of / a part of) their argument
const WRAPPERS = new Set(["Awaited", "NonNullable", "Partial", "Promise", "Readonly", "Required"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"]);
const BUILT = new Set(["ClassExpression", "NewExpression", "ObjectExpression", ...FUNCTIONS]);

/**
 * The adapter name a type or `implements` target refers to, if any.
 * @param {any} name An Identifier, MemberExpression or TSQualifiedName (last segment counts)
 * @param {any[]} args Its type arguments
 * @param {Set<string>} names Adapter interface names and this file's aliases of them
 * @returns {string | undefined}
 */
function referenced(name, args, names) {
  const last = name?.name ?? name?.right?.name ?? name?.property?.name;
  if (names.has(last)) return last;
  if (!WRAPPERS.has(last)) return undefined;
  for (const arg of args ?? []) {
    const found = adapterName(arg, names);
    if (found) return found;
  }
  return undefined;
}

/** @param {any} type A TypeScript type node @param {Set<string>} names @returns {string | undefined} */
function adapterName(type, names) {
  switch (type?.type) {
    case "TSTypeReference":
      return referenced(type.typeName, (type.typeArguments ?? type.typeParameters)?.params, names);
    case "TSUnionType":
    case "TSIntersectionType":
      return type.types.map((/** @type {any} */ t) => adapterName(t, names)).find(Boolean);
    case "TSFunctionType":
    case "TSConstructorType":
      return adapterName(type.returnType?.typeAnnotation, names);
    default:
      return undefined;
  }
}

/** @param {any} node An expression without its `as`, `satisfies` and `!` */
function unwrap(node) {
  while (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node?.type)) {
    node = node.expression;
  }
  return node;
}

/** @param {any} node An expression: does it build a value (object, class, function, `new`)? @returns {boolean} */
function builds(node) {
  node = unwrap(node);
  if (node?.type === "ConditionalExpression")
    return builds(node.consequent) || builds(node.alternate);
  if (node?.type === "LogicalExpression") return builds(node.left) || builds(node.right);
  return BUILT.has(node?.type);
}

/**
 * A function node: the values it returns, nested functions excluded. A returned
 * name (cast or not) of a `const` declared at the top of the function body stands
 * for that const's value; a const inside a nested block does not (it may shadow).
 * @param {any} fn
 */
function returnedValues(fn) {
  if (fn.body?.type !== "BlockStatement") return [fn.body];
  /** @type {any[]} */
  const found = [];
  const locals = new Map();
  /** @param {any} node */
  const visit = (node) => {
    if (node.type === "ReturnStatement") found.push(node.argument);
    if (FUNCTIONS.has(node.type)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (typeof child?.type === "string") visit(child);
      }
    }
  };
  for (const statement of fn.body.body) {
    if (statement.type === "VariableDeclaration" && statement.kind === "const") {
      for (const d of statement.declarations) {
        if (d.id.type === "Identifier") locals.set(d.id.name, d.init);
      }
    }
    visit(statement);
  }
  return found.map((v) => {
    const name = unwrap(v);
    return name?.type === "Identifier" && locals.has(name.name) ? locals.get(name.name) : v;
  });
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
      testModuleImport:
        "'{{source}}' is a test module; product code cannot import it (it may reach adapter implementations).",
      adapterOutsideAdapters:
        "'{{name}}' is implemented outside src/adapters/; adapter implementations live there, behind the composition root.",
    },
  },
  create(context) {
    const ownRoot = packageRootOf(context.filename);
    if (!ownRoot) return {};
    const ownName = JSON.parse(readFileSync(join(ownRoot, "package.json"), "utf8")).name;
    const ownPath = relative(ownRoot, context.filename).split(sep).join("/");
    const isTest = TEST_FILE.test(context.filename) || inE2eDir(context.filename);
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
        if (!isTest && (TEST_SPECIFIER.test(source) || inE2eDir(join(resolved, "_")))) {
          context.report({ node, messageId: "testModuleImport", data: { source } });
          return;
        }
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

    const names = new Set(ADAPTER_INTERFACES);
    /** @param {any} node @param {string | undefined} name */
    function implementation(node, name) {
      if (name && !mayReachAdapters) {
        context.report({ node, messageId: "adapterOutsideAdapters", data: { name } });
      }
    }
    /** @param {any} node */
    const classImplements = (node) => {
      for (const clause of node.implements ?? []) {
        implementation(clause, referenced(clause.expression, clause.typeArguments?.params, names));
      }
    };
    /** @param {any} node */
    const returns = (node) => {
      // its own type parameters constrained to an adapter (`<T extends Connector>`)
      const own = new Set(names);
      for (const param of node.typeParameters?.params ?? []) {
        if (adapterName(param.constraint, names)) own.add(param.name?.name ?? param.name);
      }
      const name = adapterName(node.returnType?.typeAnnotation, own);
      if (name && returnedValues(node).some(builds)) implementation(node, name);
    };
    /** @param {any} node */
    const typed = (node) => {
      if (builds(node.expression)) implementation(node, adapterName(node.typeAnnotation, names));
    };

    return {
      /** Collects this file's aliases of adapter names before any use is visited. */
      /** @param {any} program */
      Program: (program) => {
        /** Top-level type names and whether they refer to an adapter, given `names`. @type {[string, () => unknown][]} */
        const aliases = [];
        for (const statement of program.body) {
          const declaration = statement.declaration ?? statement;
          if (declaration.type === "TSTypeAliasDeclaration") {
            aliases.push([
              declaration.id.name,
              () => adapterName(declaration.typeAnnotation, names),
            ]);
          }
          if (declaration.type === "TSInterfaceDeclaration") {
            aliases.push([
              declaration.id.name,
              () =>
                (declaration.extends ?? []).some((/** @type {any} */ h) =>
                  referenced(h.expression, h.typeArguments?.params, names),
                ),
            ]);
          }
          for (const spec of statement.type === "ImportDeclaration" ? statement.specifiers : []) {
            const imported = spec.imported?.name ?? spec.imported?.value;
            if (spec.type === "ImportSpecifier" && names.has(imported)) names.add(spec.local.name);
          }
        }
        for (let grew = true; grew;) {
          grew = false;
          for (const [alias, refersToAdapter] of aliases) {
            if (!names.has(alias) && refersToAdapter()) {
              names.add(alias);
              grew = true;
            }
          }
        }
      },
      ClassDeclaration: classImplements,
      ClassExpression: classImplements,
      FunctionDeclaration: returns,
      FunctionExpression: returns,
      ArrowFunctionExpression: returns,
      /** @param {any} node */
      VariableDeclarator: (node) => {
        const name = adapterName(node.id?.typeAnnotation?.typeAnnotation, names);
        // a function value is judged by what it returns, as a function declaration is
        const built = FUNCTIONS.has(node.init?.type)
          ? returnedValues(node.init).some(builds)
          : builds(node.init);
        if (name && built) implementation(node, name);
      },
      TSSatisfiesExpression: typed,
      TSAsExpression: typed,
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
