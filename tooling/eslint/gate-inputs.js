// Inputs of the CLI execution decision (V01-R10, ARCHITECTURE 3.1): none of them
// may come from whoever runs the process.
// - The build kind is one value the bundler writes into the code
//   (`import.meta.PKI_BUILD_KIND`, see BUILD_KIND_MODULE). Only that module and
//   the bundler configurations (BUNDLER_CONFIGS) may mention the name, in any
//   form: an identifier, a property or key, a string or template text (which
//   also catches the old global spelling and run-time writes such as
//   `globalThis[...] = ` or `Object.defineProperty(globalThis, ...)`).
// - The decision code (DECISION_MODULES: the gate, the Broker and the modules that
//   supply the gate's inputs) touches no environment and asks the runtime nothing
//   about how it was installed: a reference to `process`, a global object
//   (`globalThis`, `global`, `self`, `window`), `Reflect`, `Function`, `eval` or
//   `createRequire`; `import.meta.env`; importing or requiring `process`,
//   `node:process`, `electron`, `module`, `node:module`, `vm`, `node:vm`; and
//   the properties `isPackaged`, `defaultApp`, `resourcesPath` fail.
// Known gaps (review catches them): a value reached through an object passed in
// from outside these files (e.g. a `process` alias handed to a function here),
// and the name of the build value assembled at run time from pieces in a module
// that is not decision code.
import { relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const BUILD_KIND_MODULE = "providers/src/build-kind.ts";
export const BUNDLER_CONFIGS = new Set(["vitest.config.ts"]);
export const DECISION_MODULES = new Set([
  // the egress side (V01-T11): whether and where a Provider request may leave
  "providers/src/adapters/openai-compatible.ts",
  "providers/src/broker.ts",
  "providers/src/build-kind.ts",
  "providers/src/cli-profiles.ts",
  "providers/src/egress-policy.ts",
  "providers/src/execution-gate.ts",
  "providers/src/secret-names.ts",
  "providers/src/synthetic-manifest.ts",
  "providers/src/user-actions.ts",
  "providers/src/verified-cli.ts",
]);
// spelled in pieces so that this file does not mention the name itself
const BUILD_VALUE = ["PKI", "BUILD", "KIND"].join("_");
const RUNTIME_GLOBALS = new Set([
  "process",
  "globalThis",
  "global",
  "self",
  "window",
  "Reflect",
  "Function",
  "eval",
  "createRequire",
]);
const RUNTIME_MODULES = new Set([
  "process",
  "node:process",
  "electron",
  "module",
  "node:module",
  "vm",
  "node:vm",
]);
const INSTALLED_CHECKS = new Set(["isPackaged", "defaultApp", "resourcesPath"]);
const NAMING_PARENTS = new Set([
  "ImportSpecifier",
  "ImportDefaultSpecifier",
  "ImportNamespaceSpecifier",
  "ExportSpecifier",
]);

/** A member's property name: `a.b` or `a["b"]`. @param {any} node */
function propertyName(node) {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : undefined;
}

/** True when `node` names something rather than reading it: `a.x`, `{ x: 1 }`, a member, a specifier. @param {any} node */
function isNameOnly(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "MemberExpression") return parent.property === node && !parent.computed;
  if (parent.type === "Property") return parent.key === node && !parent.computed;
  if (
    parent.type === "PropertyDefinition" ||
    parent.type === "MethodDefinition" ||
    parent.type === "TSPropertySignature" ||
    parent.type === "TSMethodSignature"
  ) {
    return parent.key === node && !parent.computed;
  }
  if (parent.type === "TSModuleDeclaration") return parent.id === node; // `declare global`
  if (NAMING_PARENTS.has(parent.type)) return true;
  return parent.type === "TSQualifiedName" && parent.right === node;
}

/** @type {import("eslint").Rule.RuleModule} */
const gateInputs = {
  meta: {
    type: "problem",
    docs: { description: "Keep the CLI execution decision's inputs out of the caller's hands" },
    schema: [],
    messages: {
      buildKindRead: `Only ${BUILD_KIND_MODULE} and the bundler configuration may name the build value; import BUILD_KIND from it.`,
      runtimeInput:
        "Decision code must not read environment variables, the process or global objects (V01-R10); take the value from the build or the canonical store.",
      installedCheck:
        "Decision code must not ask the runtime whether it is installed (V01-R10); the build kind decides.",
    },
  },
  create(context) {
    const rel = relative(REPO_ROOT, context.filename).split(sep).join("/");
    const mayName = rel === BUILD_KIND_MODULE || BUNDLER_CONFIGS.has(rel);
    const isDecision = DECISION_MODULES.has(rel);

    /** @param {any} node @param {unknown} text */
    function checkName(node, text) {
      if (!mayName && typeof text === "string" && text.includes(BUILD_VALUE)) {
        context.report({ node, messageId: "buildKindRead" });
      }
    }

    /** @param {any} source @param {any} node */
    function checkSource(source, node) {
      if (isDecision && source?.type === "Literal" && RUNTIME_MODULES.has(source.value)) {
        context.report({ node, messageId: "runtimeInput" });
      }
    }

    return {
      Identifier(/** @type {any} */ node) {
        checkName(node, node.name);
        if (isDecision && RUNTIME_GLOBALS.has(node.name) && !isNameOnly(node)) {
          context.report({ node, messageId: "runtimeInput" });
        }
      },
      Literal: (/** @type {any} */ node) => checkName(node, node.value),
      TemplateElement: (/** @type {any} */ node) => checkName(node, node.value.cooked),
      MemberExpression(/** @type {any} */ node) {
        if (!isDecision) return;
        const name = propertyName(node);
        if (name === undefined) return;
        if (INSTALLED_CHECKS.has(name)) context.report({ node, messageId: "installedCheck" });
        const object = node.object;
        if (name === "env" && object.type === "MetaProperty" && object.meta.name === "import") {
          context.report({ node, messageId: "runtimeInput" });
        }
      },
      Property(/** @type {any} */ node) {
        if (!isDecision || node.parent.type !== "ObjectPattern") return;
        const key = node.key;
        const name = node.computed
          ? key.type === "Literal" && key.value
          : key.type === "Identifier" && key.name;
        if (typeof name === "string" && INSTALLED_CHECKS.has(name)) {
          context.report({ node, messageId: "installedCheck" });
        }
      },
      ImportDeclaration: (/** @type {any} */ node) => checkSource(node.source, node),
      ExportNamedDeclaration: (/** @type {any} */ node) => checkSource(node.source, node),
      ExportAllDeclaration: (/** @type {any} */ node) => checkSource(node.source, node),
      ImportExpression: (/** @type {any} */ node) => checkSource(node.source, node),
      CallExpression(/** @type {any} */ node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          checkSource(node.arguments[0], node);
        }
      },
    };
  },
};

export default gateInputs;
