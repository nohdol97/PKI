// I07-T02 (I07-R2, I07-C2 ①): the old reader looked for `site/config/connector-scopes.json` relative to
// its own module (`backend/src/` -> two folders up). The registration is the only source now, so a file
// at that place must stay unread. The place is reproduced in a TEMP root, never the real repository
// root (I05-R25): the non-test sources of `backend/src` are copied to `<tmp>/backend/src`, the
// dependencies are reached through symlinks to the real `node_modules`, the decoy is put at
// `<tmp>/site/config/connector-scopes.json`, and the backend is booted from the COPY, so that any
// `new URL("../../site/config/…", import.meta.url)` in `backend/src` finds the decoy. What this does not
// see: a read in another package (storage, providers, …), which is not copied; a path that is not
// relative to the module (that is boot.connector-scopes-decoys and the text check); and a copy that
// fails to reflect a source file (the control below proves the layout resolves to the decoy).
import { routes } from "@pki/contracts";
import { send } from "@pki/testkit";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_DB_FILE } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "e".repeat(43);
const DECOY = "synthetic-decoy-marker-dddd";
const DECOY_TEXT = `${JSON.stringify({ "imp-one": [DECOY], "imp-two": [DECOY] })}\n`;
const REAL_BACKEND = resolve(import.meta.dirname, "..");
const REAL_ROOT = resolve(REAL_BACKEND, "..");
const MAIL = JSON.parse(
  readFileSync(join(REAL_ROOT, "fixtures/v02-mail.jsonl"), "utf8").split("\n")[0] as string,
) as Record<string, unknown>;

let tmp: string;
let copySrc: string;
let dataDir: string;
let booted:
  | {
      server: { port: number; close(): Promise<void> };
      db: { close(): void; all(sql: string): unknown };
    }
  | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pki-scopes-relative-"));
  copySrc = join(tmp, "backend/src");
  dataDir = join(tmp, "data");
  mkdirSync(dataDir);
  cpSync(join(REAL_BACKEND, "src"), copySrc, {
    recursive: true,
    filter: (from) => !/\.(?:test|e2e)\.[tj]sx?$/.test(from),
  });
  cpSync(join(REAL_BACKEND, "package.json"), join(tmp, "backend/package.json"));
  // the dependencies (@pki/* workspace packages and their own) resolve from the real tree
  symlinkSync(join(REAL_BACKEND, "node_modules"), join(tmp, "backend/node_modules"), "dir");
  symlinkSync(join(REAL_ROOT, "node_modules"), join(tmp, "node_modules"), "dir");
  mkdirSync(join(tmp, "site/config"), { recursive: true });
  writeFileSync(join(tmp, "site/config/connector-scopes.json"), DECOY_TEXT);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("I07-C2 ①: a range file at the module-relative place is not read", () => {
  it("control: from the copy, the old module-relative path reaches the decoy (the layout is right)", async () => {
    const probe = join(copySrc, "relative-probe.ts");
    writeFileSync(
      probe,
      'import { readFileSync } from "node:fs";\n' +
        'export const text = readFileSync(new URL("../../site/config/connector-scopes.json", import.meta.url), "utf8");\n',
    );
    const { text } = (await import(probe)) as { text: string };
    expect(text).toContain(DECOY);
  });

  it("the backend booted from the copy gives every instance NULL, and the decoy's marker is nowhere", async () => {
    const { bootBackend } = (await import(join(copySrc, "boot.ts"))) as typeof import("./boot.ts");
    booted = await bootBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [],
    });
    const { port } = booted.server;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    for (const instanceId of ["imp-one", "imp-two"]) {
      const res = await send(port, routes.imports.path, headers, "POST", {
        instanceId,
        content: JSON.stringify({
          ...MAIL,
          external_id: `e-${instanceId}`,
          connector_instance_id: instanceId,
          access_scope: ["open"],
        }),
      });
      expect(res.status).toBe(200);
    }
    expect(
      booted.db.all("SELECT id, configured_scope FROM connector_instances ORDER BY id"),
    ).toEqual([
      { id: "imp-one", configured_scope: null },
      { id: "imp-two", configured_scope: null },
    ]);
    const onDisk = readdirSync(dataDir)
      .filter((f) => f.startsWith(CANONICAL_DB_FILE))
      .some((f) => readFileSync(join(dataDir, f)).includes(DECOY));
    expect(onDisk).toBe(false);
  }, 60_000);
});
