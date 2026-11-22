// Keeps workspace packages behind their public entries (ADR 0001, V01-R1):
// a file may reach another workspace package only by its bare package name,
// and only if its own package.json declares that package as a dependency.
// A package declared only in devDependencies (test code such as @pki/testkit)
// may be imported only from test files, so it cannot reach production builds (V01-R20).
// Implementation boundary (V01-T07): adapter implementations live under a
// package's src/adapters/ and are reached only by a composition point
// (COMPOSITION_POINTS: the backend's composition root and, for a deployment fork,
// the registration file of the fork's composition package and of the public
// example package, I05-R4), through relative paths in its own package or a
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
// Deployment fork (I05-R4): a fork's packages are named "@pki-site/…" and are handled like "@pki/…" ones.
// The direction is fork -> public only: a public package may not import "@pki-site/…". A fork-shaped
// package reaches the backend by its package name alone, so nothing of backend/src (bootBackend takes
// unchecked connectors and policies) is reached by a path or a subpath, test files included.
// Absolute paths and file: URLs are resolved and judged like relative specifiers (by the package of their target);
// a file: URL that names no readable path (a foreign host, an encoded slash) is refused outright.
// Inline configuration is closed for the fork's files by eslint.config.js (`noInlineConfig` under site/ and
// packages/site-example/), not here: a comment cannot switch this rule off or give it an allow-list there.
// Semantic registry boundary (S01-T02, S01-R5, R7): the user's entry to the registry's lifecycle
// (USER_ENTRY, exported by @pki/storage) is imported only by the composition root, which hands it to
// the API layer, and by tests; the API layer (backend/src/server.ts) may name its types but not the
// value. Extraction, propagation, the job runner and every other module reach the registry through
// the automated entry, which has no approve or reject. History lines and a replaced row are SQL
// the gate module (storage/src/semantic-lifecycle.ts) alone writes: an INSERT into a history table
// and `REPLACE INTO` / `INSERT OR REPLACE` on items, facts or relations (a replace deletes the row and
// its history through the cascade, and the new row has no line) fail outside it, tests and
// @pki/testkit's seed excepted. Both look at the text of string and template literals and at
// import and export specifiers by name, and a namespace import's member access or destructuring.
// The tables are the item, fact and relation ones and their histories, and (S01-T07) the type
// definitions' `ontology_elements`, `ontology_basis` and `ontology_history`, whose INSERT and REPLACE
// are written by storage/src/ontology.ts (and the migration's seed) alone. DELETE is not checked
// (the derivative kind `ontology` deletes lineage rows and the elements it leaves without lineage), so
// a direct DELETE of `ontology_basis` outside it is a known gap.
// Known gaps (not checked):
// - the user entry reached through `import("@pki/storage")`, `export * from "@pki/storage"` or a
//   value passed in from a module that may hold it
// - SQL whose table name or verb is assembled at run time (`INSERT INTO ${table}`), or kept outside
//   a TypeScript string
// - createRequire(import.meta.url)("...") calls
// - a fork's tsconfig `paths` alias or a symlink inside its package (both are deliberate acts)
// - package.json "imports" subpaths ("#name")
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@pki/";
/** A deployment fork's packages (I05-R4); the letters live here and in tooling/workspace, nowhere in the public packages. */
const FORK_SCOPE = "@pki-site/";
/** `*.test-support.ts` is test code too (helpers no product file may import). */
const TEST_FILE = /\.(test|e2e|test-support)\.tsx?$/;
const ADAPTERS_DIR = "src/adapters";
/** The files that may pick adapter implementations (this file's header): package name and path in it. */
const COMPOSITION_ROOT = { pkg: "@pki/backend", file: "src/composition.ts" };
/** @type {{ pkg: string, file: string, dir?: string }[]} */
const COMPOSITION_POINTS = [
  COMPOSITION_ROOT,
  // the name alone is not enough: only the package at site/composition counts (a collector with that name does not)
  { pkg: "@pki-site/composition", file: "src/registration.ts", dir: "site/composition" },
  { pkg: "@pki/site-example", file: "src/registration.ts" },
];

/**
 * The one cross-package relative targets a package may import (I05-R4): `{ pkg, target }` allows `pkg` to
 * import the file `resolve(<pkg root>, target)` and no other. The resolved paths are compared, never the
 * specifier text. Empty: the I07 task adds its one entry. The rule option `allowRelative` replaces the table (tests).
 * @type {{ pkg: string, target: string }[]}
 */
const RELATIVE_ALLOWED = [];
const TEST_SPECIFIER = /\.(test|e2e|test-support)(\.[cm]?[jt]sx?)?$/;
/** A package's top-level e2e/ folder holds test code only, whatever the file names. */
const E2E_DIR = "e2e";

/** @param {string} path An absolute path @returns {boolean} */
function inE2eDir(path) {
  const root = packageRootOf(path);
  return root !== undefined && relative(root, path).split(sep)[0] === E2E_DIR;
}
const EXEMPT_PACKAGES = new Set(["@pki/testkit"]);
/**
 * @pki/connector-sdk is a pure library (I01-R24): outside the adapter boundary, importable
 * by any package that declares it, and itself importing only these (I01-R28's list).
 */
const SDK_PACKAGE = "@pki/connector-sdk";
const SDK_ALLOWED_IMPORTS = new Set([
  "@pki/contracts",
  "zod",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:path",
]);
/** What @pki/storage exports as the user's way into the Semantic registry (S01-T02). */
const USER_ENTRY = new Set(["userDecisions", "UserDecisions", "UserAction"]);
const USER_ENTRY_VALUE = "userDecisions";
const API_LAYER = { pkg: "@pki/backend", file: "src/server.ts" };
const GATE_MODULE = { pkg: "@pki/storage", file: "src/semantic-lifecycle.ts" };
// A table name as SQL may spell it: bare, quoted, or behind a schema (`main."fact_history"`).
const TABLE = String.raw`(?:["'\`[]?\w+["'\`\]]?\s*\.\s*)?["'\`[]?`;
const HISTORY_INSERT = new RegExp(
  String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+${TABLE}(?:item|fact|relation)_history\b`,
  "i",
);
// The type definitions' tables (S01-T07): rows go in through storage/src/ontology.ts alone (the seed
// is the migration's). A DELETE is not checked: the derivative kind `ontology` deletes lineage rows and
// the elements they leave without lineage (knowledge-engine canonical-kinds.ts).
const ONTOLOGY_INSERT = new RegExp(
  String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+${TABLE}ontology_(?:elements|basis|history)\b`,
  "i",
);
const ONTOLOGY_WRITERS = [
  { pkg: "@pki/storage", file: "src/ontology.ts" },
  { pkg: "@pki/storage", file: "src/migrations.ts" },
];
const ROW_REPLACE = new RegExp(
  String.raw`\bREPLACE\s+INTO\s+${TABLE}(?:items|facts|relations)\b`,
  "i",
);
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
    schema: [
      {
        type: "object",
        properties: {
          allowRelative: {
            type: "array",
            items: {
              type: "object",
              properties: { pkg: { type: "string" }, target: { type: "string" } },
              required: ["pkg", "target"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      crossPackageRelative:
        "'{{source}}' reaches into another package by path; import its package name instead.",
      deepImport: "'{{source}}' bypasses the public entry of '{{name}}'; import '{{name}}' itself.",
      undeclaredDependency: "'{{name}}' is not a declared dependency of this package.",
      devOnlyDependency:
        "'{{name}}' is only a devDependency of this package; import it from test files only.",
      adapterImport:
        "'{{source}}' is an adapter implementation; only a composition point (backend/src/composition.ts, a registration.ts of the fork's composition package or the example) may import it.",
      adapterEntry:
        "'{{source}}' is an adapter implementation entry; only a composition point (backend/src/composition.ts, a registration.ts of the fork's composition package or the example) may import it.",
      forkImport:
        "'{{source}}' is a deployment fork package; public packages cannot import it (the direction is fork to public).",
      testModuleImport:
        "'{{source}}' is a test module; product code cannot import it (it may reach adapter implementations).",
      sdkImportNotAllowed:
        "'{{source}}' is not on @pki/connector-sdk's import list (@pki/contracts, zod, node:crypto, node:fs, node:fs/promises, node:path); the SDK is a pure library.",
      adapterOutsideAdapters:
        "'{{name}}' is implemented outside src/adapters/; adapter implementations live there, behind a composition point.",
      userEntryImport:
        "'{{name}}' is the user's entry to the Semantic registry; only the composition root may import it (the API layer, its type), so extraction and the job runner cannot approve or reject.",
      registryWrite:
        "History lines and replaced item, fact or relation rows are written only by the lifecycle gate (storage/src/semantic-lifecycle.ts); the type definitions' rows only by storage/src/ontology.ts.",
    },
  },
  create(context) {
    const ownRoot = packageRootOf(context.filename);
    if (!ownRoot) return {};
    const ownName = JSON.parse(readFileSync(join(ownRoot, "package.json"), "utf8")).name;
    const ownPath = relative(ownRoot, context.filename).split(sep).join("/");
    const isTest = TEST_FILE.test(context.filename) || inE2eDir(context.filename);
    const rootPath = ownRoot.split(sep).join("/");
    const isComposition = COMPOSITION_POINTS.some(
      (p) =>
        ownName === p.pkg &&
        ownPath === p.file &&
        (p.dir === undefined || rootPath.endsWith(`/${p.dir}`)),
    );
    /** @type {{ pkg: string, target: string }[]} */
    const allowedRelative = context.options[0]?.allowRelative ?? RELATIVE_ALLOWED;
    const isFork = String(ownName).startsWith(FORK_SCOPE);
    // who may reach an implementation: a composition point, implementations themselves, tests
    const mayReachAdapters =
      isComposition || isTest || inAdapters(ownPath) || EXEMPT_PACKAGES.has(ownName);

    /**
     * The file a relative, absolute or file: URL specifier names; undefined for a package name; null for a
     * file: URL that names no readable path (a foreign host, an encoded slash), which is refused outright.
     */
    function pathOf(/** @type {string} */ source) {
      if (source.startsWith(".")) return resolve(dirname(context.filename), source);
      if (source.startsWith("file:")) {
        try {
          return fileURLToPath(source);
        } catch {
          return null;
        }
      }
      return isAbsolute(source) ? resolve(source) : undefined;
    }
    const isApiLayer = ownName === API_LAYER.pkg && ownPath === API_LAYER.file;
    // the backend's composition root alone: a fork's composition point reaches adapters, not the user entry
    const isRoot = ownName === COMPOSITION_ROOT.pkg && ownPath === COMPOSITION_ROOT.file;
    const mayHoldUserEntry = isRoot || isTest || EXEMPT_PACKAGES.has(ownName);
    const mayWriteRegistry =
      (ownName === GATE_MODULE.pkg && ownPath === GATE_MODULE.file) ||
      isTest ||
      EXEMPT_PACKAGES.has(ownName);
    const mayWriteOntology =
      isTest ||
      EXEMPT_PACKAGES.has(ownName) ||
      ONTOLOGY_WRITERS.some((w) => ownName === w.pkg && ownPath === w.file);
    /** Local names of `import * as x from "@pki/storage"`, to catch `x.userDecisions`. */
    const storageNamespaces = new Set();
    /** @param {string} name @param {boolean} typeOnly */
    const userEntryAllowed = (name, typeOnly) =>
      mayHoldUserEntry || (isApiLayer && typeOnly && name !== USER_ENTRY_VALUE);
    /** @param {any} node An import or export declaration with a source */
    function userEntry(node) {
      if (node.source?.value !== "@pki/storage") return;
      for (const spec of node.specifiers ?? []) {
        if (spec.type === "ImportNamespaceSpecifier") {
          storageNamespaces.add(spec.local.name);
          continue;
        }
        const named = spec.type === "ImportSpecifier" ? spec.imported : spec.local;
        const name = named?.name ?? named?.value;
        if (!USER_ENTRY.has(name)) continue;
        const typeOnly =
          node.importKind === "type" ||
          node.exportKind === "type" ||
          spec.importKind === "type" ||
          spec.exportKind === "type";
        if (!userEntryAllowed(name, typeOnly)) {
          context.report({ node: spec, messageId: "userEntryImport", data: { name } });
        }
      }
    }
    /** @param {any} node `const { userDecisions } = ns` where `ns` is `import * as ns from "@pki/storage"` */
    function namespaceDestructuring(node) {
      if (node.init?.type !== "Identifier" || !storageNamespaces.has(node.init.name)) return;
      if (node.id?.type !== "ObjectPattern") return;
      for (const prop of node.id.properties) {
        const key = prop.key?.name ?? prop.key?.value;
        if (prop.type === "Property" && USER_ENTRY.has(key) && !userEntryAllowed(key, false)) {
          context.report({ node: prop, messageId: "userEntryImport", data: { name: key } });
        }
      }
    }
    /** @param {any} node A Literal or TemplateLiteral: SQL text that writes what only the gate writes */
    function registrySql(node) {
      if (mayWriteRegistry && mayWriteOntology) return;
      const text =
        node.type === "TemplateLiteral"
          ? node.quasis.map((/** @type {any} */ q) => q.value.cooked ?? "").join("\0")
          : node.value;
      if (typeof text !== "string") return;
      if (
        (!mayWriteRegistry && (HISTORY_INSERT.test(text) || ROW_REPLACE.test(text))) ||
        (!mayWriteOntology && ONTOLOGY_INSERT.test(text))
      ) {
        context.report({ node, messageId: "registryWrite" });
      }
    }

    /** @param {any} node A Literal, or an expression-free TemplateLiteral */
    function check(node) {
      let source;
      if (node?.type === "Literal" && typeof node.value === "string") source = node.value;
      else if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
        source = node.quasis[0]?.value.cooked;
      }
      if (typeof source !== "string") return;
      const target = pathOf(source);
      if (target === null) {
        context.report({ node, messageId: "crossPackageRelative", data: { source } });
        return;
      }
      if (target !== undefined) {
        // Treat the target as a directory so a specifier naming a package root resolves to it.
        const resolved = target;
        if (!isTest && (TEST_SPECIFIER.test(source) || inE2eDir(join(resolved, "_")))) {
          context.report({ node, messageId: "testModuleImport", data: { source } });
          return;
        }
        if (
          allowedRelative.some(
            (a) =>
              a.pkg === ownName && resolved === resolve(/** @type {string} */ (ownRoot), a.target),
          )
        ) {
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
      if (ownName === SDK_PACKAGE && !isTest && !SDK_ALLOWED_IMPORTS.has(source)) {
        context.report({ node, messageId: "sdkImportNotAllowed", data: { source } });
        return;
      }
      if (source.startsWith(FORK_SCOPE) && !isFork) {
        context.report({ node, messageId: "forkImport", data: { source } });
        return;
      }
      if (!source.startsWith(SCOPE) && !source.startsWith(FORK_SCOPE)) return;
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
        namespaceDestructuring(node);
        const name = adapterName(node.id?.typeAnnotation?.typeAnnotation, names);
        // a function value is judged by what it returns, as a function declaration is
        const built = FUNCTIONS.has(node.init?.type)
          ? returnedValues(node.init).some(builds)
          : builds(node.init);
        if (name && built) implementation(node, name);
      },
      TSSatisfiesExpression: typed,
      TSAsExpression: typed,
      ImportDeclaration: (node) => {
        check(node.source);
        userEntry(node);
      },
      ExportNamedDeclaration: (node) => {
        check(node.source);
        userEntry(node);
      },
      /** @param {any} node */
      MemberExpression: (node) => {
        const property = node.computed ? node.property.value : node.property.name;
        if (
          node.object.type === "Identifier" &&
          storageNamespaces.has(node.object.name) &&
          USER_ENTRY.has(property) &&
          !userEntryAllowed(property, false)
        ) {
          context.report({ node, messageId: "userEntryImport", data: { name: property } });
        }
      },
      Literal: registrySql,
      TemplateLiteral: registrySql,
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      // `typeof import("...")` in TypeScript type positions
      /** @param {any} node */
      TSImportType: (node) => check(node.argument?.literal),
    };
  },
};

export default moduleBoundary;
