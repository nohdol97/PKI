// Consent records (V01-R12, ADR 0014): one per Provider, bound to the destination
// and policy version it was given for. Judging whether it still holds is the
// egress policy's work (@pki/providers); this module only stores it.
import type { SqlDriver } from "./sql-driver.ts";

export interface StoredConsent {
  provider: string;
  destination: string;
  policyVersion: string;
  /** The data classes the user chose to allow. */
  allowedClasses: string[];
  grantedAt: string;
}

/** Stored classes that are not a JSON list of strings read as none (fail closed). */
function parseClasses(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

export function readConsent(db: SqlDriver, provider: string): StoredConsent | undefined {
  const row = db.all(
    `SELECT provider, destination, policy_version, allowed_classes, granted_at
     FROM consents WHERE provider = ?`,
    [provider],
  )[0];
  if (!row) return undefined;
  return {
    provider: row.provider as string,
    destination: row.destination as string,
    policyVersion: row.policy_version as string,
    allowedClasses: parseClasses(row.allowed_classes as string),
    grantedAt: row.granted_at as string,
  };
}

/** Replaces the Provider's consent, if any. */
export function saveConsent(db: SqlDriver, consent: StoredConsent): void {
  db.run(
    `INSERT INTO consents (provider, destination, policy_version, allowed_classes, granted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET destination = excluded.destination,
       policy_version = excluded.policy_version, allowed_classes = excluded.allowed_classes,
       granted_at = excluded.granted_at`,
    [
      consent.provider,
      consent.destination,
      consent.policyVersion,
      JSON.stringify(consent.allowedClasses),
      consent.grantedAt,
    ],
  );
}

export function deleteConsent(db: SqlDriver, provider: string): void {
  db.run("DELETE FROM consents WHERE provider = ?", [provider]);
}
