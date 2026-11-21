// Runtime settings (V01-R6 settings table): plain key/value text. Values that must
// not be settable here (build kind, verified CLI list, instructions…) are build
// resources and never read from this table.
import type { SqlDriver } from "./sql-driver.ts";

export function readSetting(db: SqlDriver, key: string): string | undefined {
  return db.all("SELECT value FROM settings WHERE key = ?", [key])[0]?.value as string | undefined;
}

export function writeSetting(db: SqlDriver, key: string, value: string): void {
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}
