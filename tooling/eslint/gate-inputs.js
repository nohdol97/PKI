// Inputs of the CLI execution decision (V01-R10, ARCHITECTURE 3.1): none of them
// may come from whoever runs the process.
// - The build kind is one value the bundler writes into the code
//   (`__PKI_BUILD_KIND__`), and only BUILD_KIND_MODULE reads it. Any other mention
//   of the name fails, a `declare` included; an object key that names it (the
//   bundler's `define` configuration) reads nothing and passes.
// - The decision code (DECISION_MODULES: the gate, the Broker and the modules they
//   read) touches no environment and asks the runtime nothing about how it was
//   installed: any reference to the `process` global, `globalThis.process` and the
//   like, `import.meta.env`, importing or requiring `process`, `node:process` or
//   `electron`, and the properties `isPackaged`, `defaultApp`, `resourcesPath` fail.
// Known gaps (review catches them): reaching `process` through an alias created
// outside these files and passed in, `Function("return process")()`, a computed
// property name other than a string literal.
import { relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const BUILD_KIND_MODULE = "providers/src/build-kind.ts";
export const DECISION_MODULES = new Set([
  "providers/src/broker.ts",
  "providers/src/build-kind.ts",
  "providers/src/cli-profiles.ts",
  "providers/src/execution-gate.ts",
  "providers/src/verified-cli.ts",
]);
const BUILD_VALUE = "__PKI_BUILD_KIND__";
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window"]);
const RUNTIME_MODULES = new Set(["process", "node:process", "electron"]);
const INSTALLED_CHECKS = new Set(["isPackaged", "defaultApp", "resourcesPath"]);

/** A member's property name: `a.b` or `a["b"]`. @param {any} node */
function propertyName(node) {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : undefined;
}

/** True when `node` names something rather than reading it: `a.x`, `{ x: 1 }`, a class member. @param {any} node */
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
  return parent.type === "TSQualifiedName" && parent.right === node;
}

/** @type {import("eslint").Rule.RuleModule} */
const gateInputs = {
  meta: {
    type: "problem",
    docs: { description: "Keep the CLI execution decision's inputs out of the caller's hands" },
    schema: [],
    messages: {
      buildKindRead: `Only ${BUILD_KIND_MODULE} reads ${BUILD_VALUE}; import BUILD_KIND from it.`,
      runtimeInput:
        "Decision code must not read environment variables or the process (V01-R10); take the value from the build or the canonical store.",
      installedCheck:
        "Decision code must not ask the runtime whether it is installed (V01-R10); the build kind decides.",
    },
  },
  create(context) {
    const rel = relative(REPO_ROOT, context.filename).split(sep).join("/");
    const readsBuildValue = rel === BUILD_KIND_MODULE;
    const isDecision = DECISION_MODULES.has(rel);

    /** @param {any} source @param {any} node */
    function checkSource(source, node) {
      if (isDecision && source?.type === "Literal" && RUNTIME_MODULES.has(source.value)) {
        context.report({ node, messageId: "runtimeInput" });
      }
    }

    return {
      Identifier(/** @type {any} */ node) {
        if (isNameOnly(node)) return;
        if (node.name === BUILD_VALUE && !readsBuildValue) {
          context.report({ node, messageId: "buildKindRead" });
        }
        if (node.name === "process" && isDecision) {
          context.report({ node, messageId: "runtimeInput" });
        }
      },
      MemberExpression(/** @type {any} */ node) {
        const name = propertyName(node);
        if (name === BUILD_VALUE && node.computed && !readsBuildValue) {
          context.report({ node, messageId: "buildKindRead" });
        }
        if (!isDecision || name === undefined) return;
        if (INSTALLED_CHECKS.has(name)) context.report({ node, messageId: "installedCheck" });
        const object = node.object;
        if (name === "process" && object.type === "Identifier" && GLOBAL_OBJECTS.has(object.name)) {
          context.report({ node, messageId: "runtimeInput" });
        }
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
