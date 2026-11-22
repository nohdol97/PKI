// The scope a deployment configured for each Connector instance (I01-R15, I07-R2, R3): it arrives
// as `SiteRegistration.connectorScopes` (instance id -> array of scope values), the fork's file
// bound at build time, and is read nowhere else: this module touches no file, environment, argument
// or module location. The public registration carries none, so every instance's configured scope is
// unknown (null); the Broker grades an imported scope as the strictest class against an unknown one.
// A value that is not an object, or an entry that is not an array of strings, makes that instance
// unknown too: nothing here ever widens a grade. The scope is copied into
// `connector_instances.configured_scope` (start, and when a sync or an import first names an instance)
// because that is where the Broker reads it; no API route returns it. The table is made once per
// started backend and handed to every place that copies it.
import { normalizeScope, listConnectorInstanceIds, setConfiguredScope } from "@pki/storage";
import type { AccessScope, SqlDriver } from "@pki/storage";

export type ConnectorScopes = ReadonlyMap<string, AccessScope>;

/** No configured scope for any instance: the closed side that a caller handing no table gets. */
export const NO_SCOPES: ConnectorScopes = new Map();

/** How the registration's value stood: no field, not an object, no entry with a scope, or at least one. */
export type ScopesState = "absent" | "invalid" | "empty" | "bound";

export interface BoundConnectorScopes {
  scopes: ConnectorScopes;
  state: ScopesState;
  /** Entries of an object that were not used (a bad entry leaves only its instance unknown). */
  rejected: number;
  /** Own entries of the object, used or not. */
  entries: number;
  /** Entries that carry a scope (not null) and were used. */
  configured: number;
}

const unusable = (state: "absent" | "invalid"): BoundConnectorScopes => ({
  scopes: new Map(),
  state,
  rejected: 0,
  entries: 0,
  configured: 0,
});

/** Instance id -> scope from the registration's value; what is not a well-formed entry is left out (unknown). */
export function bindConnectorScopes(value: unknown): BoundConnectorScopes {
  if (value === undefined) return unusable("absent");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return unusable("invalid");
  }
  const scopes = new Map<string, AccessScope>();
  let rejected = 0;
  let entries = 0;
  let configured = 0;
  try {
    // own keys only; a Map keeps a key like `__proto__` as an ordinary id
    for (const [id, held] of Object.entries(value)) {
      entries++;
      if (held === null) scopes.set(id, null);
      else if (Array.isArray(held) && held.every((v) => typeof v === "string" && v !== "")) {
        scopes.set(id, normalizeScope(held as string[]));
        configured++;
      } else rejected++;
    }
  } catch {
    // a value that throws when read is unusable as a whole: the closed side, never a stop
    return unusable("invalid");
  }
  return { scopes, state: configured > 0 ? "bound" : "empty", rejected, entries, configured };
}

/** One instance's configured scope into its row; an instance the table does not name is unknown. */
export function applyConfiguredScope(
  db: SqlDriver,
  instanceId: string,
  scopes: ConnectorScopes,
): void {
  setConfiguredScope(db, instanceId, scopes.get(instanceId) ?? null);
}

/** Every instance row follows the table: a scope removed from it is cleared (unknown), not kept. */
export function applyConfiguredScopes(db: SqlDriver, scopes: ConnectorScopes): void {
  db.transaction(() => {
    for (const id of listConnectorInstanceIds(db)) applyConfiguredScope(db, id, scopes);
  });
}
