// The scope a deployment configured for each Connector instance (I01-R15). It is a build
// resource, `site/config/connector-scopes.json` (instance id -> array of scope values), bound
// at build time and read only while running, like the verified CLI list. The public
// repository does not ship the file, so every instance's configured scope is unknown (null);
// the Broker grades an imported scope as the strictest class against an unknown one. A file
// that cannot be read, is not an object, or holds an entry that is not an array of strings
// makes that instance unknown too: nothing here ever widens a grade. The scope is copied into
// `connector_instances.configured_scope` (start, and when a sync first names an instance)
// because that is where the Broker reads it; no API route returns it.
import { normalizeScope, listConnectorInstanceIds, setConfiguredScope } from "@pki/storage";
import type { AccessScope, SqlDriver } from "@pki/storage";
import { readFileSync } from "node:fs";

export type ConnectorScopes = ReadonlyMap<string, AccessScope>;

export const CONNECTOR_SCOPES_FILE = new URL(
  "../../site/config/connector-scopes.json",
  import.meta.url,
);

export interface ParsedConnectorScopes {
  scopes: ConnectorScopes;
  /** Entries (or the whole file, counted as one) that were not used. */
  rejected: number;
}

/** Instance id -> scope from the file's text; what is not a well-formed entry is left out (unknown). */
export function parseConnectorScopes(text: string): ParsedConnectorScopes {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { scopes: new Map(), rejected: 1 };
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return { scopes: new Map(), rejected: 1 };
  }
  const scopes = new Map<string, AccessScope>();
  let rejected = 0;
  for (const [id, value] of Object.entries(root)) {
    if (value === null) scopes.set(id, null);
    else if (Array.isArray(value) && value.every((v) => typeof v === "string" && v !== "")) {
      scopes.set(id, normalizeScope(value as string[]));
    } else rejected++;
  }
  return { scopes, rejected };
}

/** The file's text, or undefined when there is no file (the public repository). */
function readFileText(): string | undefined {
  try {
    return readFileSync(CONNECTOR_SCOPES_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return "unreadable"; // not JSON: parsed as an invalid file, so every instance stays unknown
  }
}

export function loadConnectorScopes(read: () => string | undefined = readFileText): {
  scopes: ConnectorScopes;
  rejected: number;
} {
  const text = read();
  return text === undefined ? { scopes: new Map(), rejected: 0 } : parseConnectorScopes(text);
}

/** The configured scopes of this build (bound when the module is loaded). */
export const CONNECTOR_SCOPES: ParsedConnectorScopes = loadConnectorScopes();

/** One instance's configured scope into its row; an instance the file does not name is unknown. */
export function applyConfiguredScope(
  db: SqlDriver,
  instanceId: string,
  scopes: ConnectorScopes = CONNECTOR_SCOPES.scopes,
): void {
  setConfiguredScope(db, instanceId, scopes.get(instanceId) ?? null);
}

/** Every instance row follows the file: a scope removed from it is cleared (unknown), not kept. */
export function applyConfiguredScopes(
  db: SqlDriver,
  scopes: ConnectorScopes = CONNECTOR_SCOPES.scopes,
): void {
  db.transaction(() => {
    for (const id of listConnectorInstanceIds(db)) applyConfiguredScope(db, id, scopes);
  });
}
