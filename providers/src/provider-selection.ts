// The default Provider (V01-R9, C4; T10 handoff 8): the one Provider the Broker
// calls is the one the user chose, read from the settings table for every call.
// Without a choice, or with a name that is not bound, none is called ("no-provider"):
// nothing is picked on the user's behalf, not even the only CLI installed, since
// what is installed can change between calls and the call would then go to a
// Provider the user never chose (no silent fallback, V01-R5).
// Decision code: lint `pki/gate-inputs` keeps environment variables and "is this
// installed" checks out of this file.
import { PROVIDER_IDS, type LLMProvider, type ProviderId } from "@pki/contracts";
import { readSetting, writeSetting, type SqlDriver } from "@pki/storage";

/** Runtime setting (site-setup.md): the chosen Provider's name. */
export const DEFAULT_PROVIDER_SETTING = "providers.default";

const KNOWN: ReadonlySet<string> = new Set(PROVIDER_IDS);

/** The chosen Provider's name; undefined when unset or not a Provider name. */
export function readDefaultProvider(db: SqlDriver): ProviderId | undefined {
  const value = readSetting(db, DEFAULT_PROVIDER_SETTING);
  return value !== undefined && KNOWN.has(value) ? (value as ProviderId) : undefined;
}

export function writeDefaultProvider(db: SqlDriver, id: ProviderId): void {
  writeSetting(db, DEFAULT_PROVIDER_SETTING, id);
}

/** The bound Provider named `chosen`, or none. */
export function selectProvider(
  bound: readonly LLMProvider[],
  chosen: ProviderId | undefined,
): LLMProvider | undefined {
  return chosen === undefined ? undefined : bound.find((p) => p.id === chosen);
}
