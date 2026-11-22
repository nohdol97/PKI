// I07-C2 ④ `artifact.scopes-decoys` (I07-R2, R9): the built `backend/shell.js` takes the instance scopes from
// its bundle and from nothing laid around it. It is copied beside a temporary "dist" so its old
// module-relative place (`<app folder's parent>/site/config/`, where the former reader pointed once bundled,
// I07-T01 measure 1) is a temporary folder, never the repository's. Decoy scopes files (the instance a decoy
// names gets a marker value) lie there, in the working directory, in the data directory and under it, and
// path-looking environment variables point at one; the built backend is started by the Electron binary's
// Node as the shell starts it and an import names the decoy's instance. Its stored `configured_scope` is
// NULL: no registration bound a scope for the decoy's instance, and the marker is nowhere in the rows or the log.
import { expect, test } from "@playwright/test";
import { resolveDataDirectory } from "@pki/storage";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APP_DIR } from "../build/paths.ts";
import { ELECTRON } from "../e2e/launch.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
const INSTANCE = "decoy-instance";
const MARKER = "DECOY-SCOPE-MARKER-7f3a";

let dir: string;
test.beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-artifact-scopes-"))));
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

function decoy(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ [INSTANCE]: [MARKER] }));
}

test("the built backend does not read a scopes file from the old module-relative place, the working directory, the data directory or an environment variable", async () => {
  test.setTimeout(90_000);
  // <dir>/dist/app is a copy of the built app folder's backend; its node_modules is the built one
  const app = join(dir, "dist", "app");
  mkdirSync(join(app, "backend"), { recursive: true });
  copyFileSync(join(APP_DIR, "backend", "shell.js"), join(app, "backend", "shell.js"));
  copyFileSync(join(APP_DIR, "package.json"), join(app, "package.json"));
  symlinkSync(join(APP_DIR, "node_modules"), join(app, "node_modules"), "junction");

  const home = join(dir, "home");
  const cwd = join(dir, "cwd");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_DATA_HOME: join(dir, "xdg"),
    TMPDIR: tmpdir(),
    ELECTRON_RUN_AS_NODE: "1",
  };
  const dataDir = resolveDataDirectory({ platform: process.platform, home, env });
  const places = [
    join(dir, "dist", "site", "config", "connector-scopes.json"),
    join(cwd, "site", "config", "connector-scopes.json"),
    join(dataDir, "connector-scopes.json"),
    join(dataDir, "site", "config", "connector-scopes.json"),
    join(dir, "elsewhere", "connector-scopes.json"),
  ];
  for (const place of places) decoy(place);
  mkdirSync(cwd, { recursive: true });
  for (const name of ["CONNECTOR_SCOPES_FILE", "PKI_CONNECTOR_SCOPES", "PKI_SCOPES_FILE"]) {
    env[name] = places[4] as string;
  }

  const token = randomBytes(32).toString("base64url");
  const child = fork(join(app, "backend", "shell.js"), ["--origin", "app://pki"], {
    execPath: ELECTRON,
    env,
    cwd,
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      child.on("message", (m: { type?: string; port?: number }) => {
        if (m.type === "ready" && m.port) resolvePort(m.port);
        if (m.type === "failed") reject(new Error("backend failed"));
      });
      child.once("exit", (code) => reject(new Error(`backend exited (${code}): ${stderr}`)));
      child.send({ type: "start", token });
    });
    const mail = JSON.parse(
      readFileSync(join(FIXTURES, "v02-mail.jsonl"), "utf8").split("\n")[0] ?? "",
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/imports`, {
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        instanceId: INSTANCE,
        content: JSON.stringify({
          ...mail,
          external_id: "decoy-1",
          connector_instance_id: INSTANCE,
          access_scope: ["open"],
        }),
      }),
    });
    expect(response.status).toBe(200);
  } finally {
    if (child.connected) child.send({ type: "stop" });
    expect(await exited).toBe(0);
  }
  // the start's log names one state of the bundled value and nothing of the decoys
  expect(stderr).toMatch(/"event":"connector-scopes-(absent|invalid|empty|bound)"/);
  expect(stderr).not.toContain(MARKER);
  const db = new DatabaseSync(join(dataDir, "pki.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, configured_scope FROM connector_instances").all() as {
      id: string;
      configured_scope: string | null;
    }[];
    expect(rows.map((r) => r.id)).toContain(INSTANCE);
    expect(rows.find((r) => r.id === INSTANCE)?.configured_scope).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(MARKER);
  } finally {
    db.close();
  }
});
