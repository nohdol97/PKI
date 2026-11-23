// V01-R12 consent records and the settings they depend on: one consent per
// Provider, bound to the destination and policy version it was given for.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { deleteConsent, readConsent, saveConsent } from "./consents.ts";
import { migrate } from "./migrations.ts";
import { readSetting, writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
});
afterEach(() => db.close());

const consent = {
  provider: "codex",
  destination: "vendor:codex",
  policyVersion: "pv-1",
  allowedClasses: ["synthetic"],
  grantedAt: "2026-11-21T00:00:00.000Z",
};

describe("consents", () => {
  it("stores, replaces and deletes the one consent of a Provider", () => {
    expect(readConsent(db, "codex")).toBeUndefined();
    saveConsent(db, consent);
    expect(readConsent(db, "codex")).toEqual(consent);
    const replaced = {
      ...consent,
      policyVersion: "pv-2",
      allowedClasses: ["synthetic", "general"],
    };
    saveConsent(db, replaced);
    expect(readConsent(db, "codex")).toEqual(replaced);
    expect(db.all("SELECT count(*) AS n FROM consents")).toEqual([{ n: 1 }]);
    deleteConsent(db, "codex");
    expect(readConsent(db, "codex")).toBeUndefined();
  });

  it("reads unreadable stored classes as none", () => {
    saveConsent(db, consent);
    db.run("UPDATE consents SET allowed_classes = '{\"x\":1}'");
    expect(readConsent(db, "codex")?.allowedClasses).toEqual([]);
    db.run("UPDATE consents SET allowed_classes = '[1, \"general\"]'");
    expect(readConsent(db, "codex")?.allowedClasses).toEqual(["general"]);
  });
});

describe("settings", () => {
  it("reads what was written and undefined for a missing key", () => {
    expect(readSetting(db, "providers.openaiCompatible.baseUrl")).toBeUndefined();
    writeSetting(db, "providers.openaiCompatible.baseUrl", "https://a.example/v1");
    writeSetting(db, "providers.openaiCompatible.baseUrl", "https://b.example/v1");
    expect(readSetting(db, "providers.openaiCompatible.baseUrl")).toBe("https://b.example/v1");
  });
});
