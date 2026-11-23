// I02B-C18 (I02B-R22): no product file of the backend takes `normalizeDocument`. The parser runs in the
// normalizer host only; the backend may take the isolated normalizer, its spawners and types. The check
// reads every import, export-from and dynamic import of `@pki/document-normalize` by name, so a rename,
// a namespace import and a re-export are seen too. Test files (and the stand-in's test support) are out.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = import.meta.dirname;
const PACKAGE = "@pki/document-normalize";
/** What the backend's product code may take from the package. */
const ALLOWED = new Set(["createIsolatedNormalizer", "createForkSpawner", "NORMALIZER_VERSION"]);

/** The imports of the package that take something outside ALLOWED (types are never values). */
export function forbiddenImports(source: string): string[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const mentions = (spec: ts.Expression | undefined) =>
    spec !== undefined &&
    ts.isStringLiteralLike(spec) &&
    (spec.text === PACKAGE || /document-normalize/.test(spec.text));
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && mentions(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause === undefined || clause.name !== undefined)
        found.push("default or side-effect import");
      else if (clause.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings))
          found.push("namespace import");
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const name = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && !ALLOWED.has(name)) found.push(name);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && mentions(node.moduleSpecifier) && !node.isTypeOnly) {
      found.push("re-export");
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      mentions(node.arguments[0])
    ) {
      found.push("dynamic import");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Product files of the backend: not tests, not test support, not E2E helpers. */
function productFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name))
    .filter((p) => !/\.(test|e2e|test-support)\.ts$/.test(p));
}

describe("I02B-C18: the backend's product code does not take the parser", () => {
  it("no product file imports normalizeDocument, however it is spelled", () => {
    const files = productFiles(SRC);
    expect(files.length).toBeGreaterThan(30);
    const found = files.flatMap((f) =>
      forbiddenImports(readFileSync(f, "utf8")).map((what) => `${f}: ${what}`),
    );
    expect(found).toEqual([]);
  });

  it.each([
    ['import { normalizeDocument } from "@pki/document-normalize";', ["normalizeDocument"]],
    ['import { normalizeDocument as n } from "@pki/document-normalize";', ["normalizeDocument"]],
    ['import * as dn from "@pki/document-normalize";', ["namespace import"]],
    ['import dn from "@pki/document-normalize";', ["default or side-effect import"]],
    ['export { normalizeDocument } from "@pki/document-normalize";', ["re-export"]],
    ['const m = await import("@pki/document-normalize");', ["dynamic import"]],
    [
      'import { normalizeDocument } from "../../packages/document-normalize/src/index.ts";',
      ["normalizeDocument"],
    ],
  ])("the check fails on %s", (source, expected) => {
    expect(forbiddenImports(source)).toEqual(expected);
  });

  it("the check passes the isolated normalizer, its spawners and the types", () => {
    expect(
      forbiddenImports(
        'import { createIsolatedNormalizer, createForkSpawner, type HostSpawner } from "@pki/document-normalize";\nimport type { IsolatedResult } from "@pki/document-normalize";',
      ),
    ).toEqual([]);
  });
});
