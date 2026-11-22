// I05-T03 (I05-R14, I05-C12): a registration's scope -> class mapping is the one the booted
// backend's own Broker asks. The mapping records its calls, because the public repository has one
// class and the result alone could not tell which mapping was used. The build's scope file is a map the
// test holds (none ships), as in claimed-scope.import.test.ts.
import { routes } from "@pki/contracts";
import type { ScopeGrading } from "@pki/providers";
import { send } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const held = vi.hoisted(() => ({ scopes: new Map<string, string[] | null>() }));
vi.mock("./connector-scopes.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./connector-scopes.ts")>();
  return {
    ...real,
    get CONNECTOR_SCOPES() {
      return { scopes: held.scopes, rejected: 0, file: "read" };
    },
    applyConfiguredScope: (db: Parameters<typeof real.applyConfiguredScope>[0], id: string) =>
      real.applyConfiguredScope(db, id, held.scopes),
    applyConfiguredScopes: (db: Parameters<typeof real.applyConfiguredScopes>[0]) =>
      real.applyConfiguredScopes(db, held.scopes),
  };
});

const { bootBackend } = await import("./boot.ts");
const { NO_SECRET_STORE } = await import("./secret-sources.ts");

const TOKEN = "g".repeat(43);
const MAIL = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8").split(
    "\n",
  )[0] as string,
) as Record<string, unknown>;

let asked: string[];
const grading: ScopeGrading = {
  grade: (scope) => {
    asked.push(`grade:${scope?.join("+") ?? "null"}`);
    return "general";
  },
  strictest: (classes) => {
    asked.push(`strictest:[${classes.join(",")}]`);
    return "general";
  },
};
const testGrading: ScopeGrading = {
  grade: () => {
    asked.push("test-grade");
    return "general";
  },
  strictest: () => {
    asked.push("test-strictest");
    return "general";
  },
};

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-site-grading-"));
  held.scopes = new Map([["imp-site", ["team"]]]);
  asked = [];
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Boots with the given extras, imports one claimed line, and gives the time the extraction had to grade it. */
async function importedWith(extra: Record<string, unknown>) {
  booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    ...extra,
  });
  const port = booted.server.port;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  const res = await send(port, routes.imports.path, headers, "POST", {
    instanceId: "imp-site",
    content: JSON.stringify({
      ...MAIL,
      external_id: "a1",
      connector_instance_id: "imp-site",
      access_scope: ["open"],
    }),
  });
  expect(res.status).toBe(200);
}

describe("site.scope-grading: the registration's mapping reaches the booted Broker (I05-R14)", () => {
  it("the Broker of the extraction asks the registration's mapping", async () => {
    await importedWith({ site: { scopeGrading: grading } });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked.every((a) => !a.startsWith("test-"))).toBe(true);
  });

  it("a registration without a mapping asks none: the public mapping answers", async () => {
    await importedWith({ site: {} });
    // the extraction ran or was held by now; nothing recorded because no recording mapping is bound
    await new Promise((r) => setTimeout(r, 200));
    expect(asked).toEqual([]);
  });

  it("the registration's mapping wins over the test build's own injection", async () => {
    await importedWith({ site: { scopeGrading: grading }, scopeGrading: testGrading });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked.some((a) => a.startsWith("test-"))).toBe(false);
  });

  it("the test build's injection still works when the registration has none (as before)", async () => {
    await importedWith({ scopeGrading: testGrading });
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked.every((a) => a.startsWith("test-"))).toBe(true);
  });
});
