// The build's judgment of the instance scopes file (I07-R7, R8): a pure function of the repository root,
// the bundled backend entry and the bundle's module list. It runs no code of the fork. It looks at three
// things only: which entry was bundled, the repository modules of the bundle whose name ends with
// `connector-scopes.json`, and the file at the allowed place. It lives here, outside the five product
// roots and out of every bundle, because it names the place of the file (I07-C2 ③, C10). The root is an
// argument (I05-R25): nothing here reads the real checkout by itself. The decision diagram is in
// docs/specs/2026-11-22-I07-installed-scopes-file.md ("빌드 판정").
import { EXAMPLE_SCOPE_MARKER } from "@pki/contracts";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const FILE_NAME = "connector-scopes.json";
/** The one place of the file for the public entry and a fork's composition package (I07-R7). */
const FORK_PLACE = `site/config/${FILE_NAME}`;
/** The example package's own place, allowed for its own entry alone: only the public repository's tests bundle it. */
const EXAMPLE_PLACE = `packages/site-example/config/${FILE_NAME}`;
const EXAMPLE_ENTRY = "packages/site-example/src/shell.ts";

export type ScopesFailure =
  | "scopes-file-misplaced"
  | "scopes-file-unbound"
  | "scopes-file-invalid"
  | "scopes-file-placeholder";

/** What the build report records (I07-R7): the state and two counts, never a value or an id. */
export interface ScopesReport {
  state: "absent" | "empty" | "bound";
  /** Own entries of the file. */
  entries: number;
  /** Entries that carry a scope (not null). */
  configured: number;
}

export type ScopesVerdict =
  ({ ok: true } & ScopesReport) | { ok: false; code: ScopesFailure; message: string };

const fail = (code: ScopesFailure, place: string, why: string): ScopesVerdict => ({
  ok: false,
  code,
  message: `${code}: ${place} ${why}`,
});

/**
 * Whether the raw text of a JSON document names an object key twice, comparing the keys by their unescaped
 * letters (`"a"` and `"a"` are one key). A parsed object has already lost the earlier value, so the
 * text is scanned; the text must be valid JSON.
 */
function hasDuplicateKey(text: string): boolean {
  /** One entry per open container: the keys seen so far of an object, undefined for an array. */
  const open: (Set<string> | undefined)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      open.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      open.push(undefined);
      expectKey = false;
    } else if (c === "}" || c === "]") {
      open.pop();
      expectKey = false;
    } else if (c === ",") {
      expectKey = open[open.length - 1] !== undefined;
    } else if (c === ":") {
      expectKey = false;
    } else if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const keys = open[open.length - 1];
      if (expectKey && keys !== undefined) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
      }
      i = end;
    }
  }
  return false;
}

const isScope = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s !== "");

/**
 * Judges the scopes file of the build that bundled `entry` into a bundle listing `modules`
 * (repository paths with `/`). Passes with the state `absent`, `empty` or `bound`; fails with one of the four codes.
 */
export function judgeConnectorScopes(
  root: string,
  entry: string,
  modules: readonly string[],
): ScopesVerdict {
  const entryPath = relative(root, entry).split(sep).join("/");
  const place = entryPath === EXAMPLE_ENTRY ? EXAMPLE_PLACE : FORK_PLACE;
  const outside = modules.filter((m) => m.endsWith(FILE_NAME) && m !== place);
  if (outside.length > 0) {
    return fail(
      "scopes-file-misplaced",
      outside.join(", "),
      `is in the bundle but the only allowed place is ${place}`,
    );
  }
  const file = join(root, place);
  if (!existsSync(file)) return { ok: true, state: "absent", entries: 0, configured: 0 };
  if (!modules.includes(place)) {
    return fail(
      "scopes-file-unbound",
      place,
      "exists but the backend bundle does not keep it: the registration does not import it into connectorScopes",
    );
  }
  const text = readFileSync(file, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("scopes-file-invalid", place, "is not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("scopes-file-invalid", place, "is not an object of instance id to scopes");
  }
  const entries = Object.entries(value);
  if (Object.hasOwn(value, "__proto__")) {
    return fail("scopes-file-invalid", place, "has the key __proto__");
  }
  if (!entries.every(([, held]) => held === null || isScope(held))) {
    return fail(
      "scopes-file-invalid",
      place,
      "has an entry that is neither null nor a list of non-empty strings",
    );
  }
  if (hasDuplicateKey(text))
    return fail("scopes-file-invalid", place, "names an instance key twice");
  const scoped = entries.filter(([, held]) => held !== null);
  if (scoped.some(([, held]) => (held as string[]).includes(EXAMPLE_SCOPE_MARKER))) {
    return fail("scopes-file-placeholder", place, "still holds the example's scope value");
  }
  return {
    ok: true,
    state: scoped.length > 0 ? "bound" : "empty",
    entries: entries.length,
    configured: scoped.length,
  };
}

/** What the build does with the verdict: the report's part when it passes, and a thrown error, stopping the build, when it fails. */
export function requireConnectorScopes(
  root: string,
  entry: string,
  modules: readonly string[],
): ScopesReport {
  const verdict = judgeConnectorScopes(root, entry, modules);
  if (!verdict.ok) throw new Error(verdict.message);
  return { state: verdict.state, entries: verdict.entries, configured: verdict.configured };
}
