// I07-C11 ④⑤⑥ `site.example-scopes` (I07-R1, R5, R10): the example registration carries its scopes file
// from the registration to the canonical database. A sync-free path: the example's own shell entry is started
// as a fork's is, the example's instance named in its scopes file imports one record, and the stored
// `configured_scope` is the file's value (sorted, no duplicates). The database is opened read-only after the
// app stopped. The registration's source line that imports the file keeps `with { type: "json" }`: without it
// Node's source run fails while the type check and vitest pass, so the text is what holds it.
import { checkSiteRegistration } from "@pki/backend";
import { routes } from "@pki/contracts";
import { send } from "@pki/testkit";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import scopesFile from "../config/connector-scopes.json" with { type: "json" };
import { registration } from "./registration.ts";

const SHELL = fileURLToPath(new URL("./shell.ts", import.meta.url));
const REGISTRATION_SOURCE = fileURLToPath(new URL("./registration.ts", import.meta.url));
const MAIL_FIXTURE = fileURLToPath(new URL("../../../fixtures/v02-mail.jsonl", import.meta.url));
const TOKEN = "s".repeat(43);
/** The instance the example's scopes file names for an import (I07 spec "미해결 질문" 4). */
const INSTANCE = "example-import";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-site-example-scopes-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("site.example-scopes", () => {
  it("④ the example registration passes the product's check: neither scopes code is raised", () => {
    expect(checkSiteRegistration(registration)).not.toContain("connector-scopes-field-invalid");
    expect(checkSiteRegistration(registration)).not.toContain("connector-scopes-entry-invalid");
    expect(registration.connectorScopes).toEqual(scopesFile);
  });

  it("⑤ an import into the instance the file names leaves the file's value in the canonical database", async () => {
    const proc = fork(SHELL, ["--data-dir", join(dir, "data")], {
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    try {
      const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));
      const port = await new Promise<number>((resolve, reject) => {
        proc.on("message", (m: { type?: string; port?: number }) => {
          if (m.type === "ready" && m.port) resolve(m.port);
          if (m.type === "failed") reject(new Error("the example failed to start"));
        });
        proc.send({ type: "start", token: TOKEN });
      });
      const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
      const mail = JSON.parse(readFileSync(MAIL_FIXTURE, "utf8").split("\n")[0] as string);
      const imported = await send(port, routes.imports.path, headers, "POST", {
        instanceId: INSTANCE,
        content: JSON.stringify({
          ...mail,
          external_id: "example-scopes-1",
          connector_instance_id: INSTANCE,
          access_scope: ["open"],
        }),
      });
      expect(imported.status).toBe(200);
      proc.send({ type: "stop" });
      expect(await exited).toBe(0);
    } finally {
      proc.kill("SIGKILL");
    }
    const db = new DatabaseSync(join(dir, "data", "pki.sqlite"), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT configured_scope FROM connector_instances WHERE id = ?")
        .get(INSTANCE) as { configured_scope: string | null } | undefined;
      const expected = [...new Set((scopesFile as Record<string, string[]>)[INSTANCE])].sort();
      expect(row?.configured_scope).toBe(JSON.stringify(expected));
    } finally {
      db.close();
    }
  }, 60_000);

  it("⑥ the registration's import line of the scopes file has the JSON import attribute", () => {
    const line = readFileSync(REGISTRATION_SOURCE, "utf8")
      .split("\n")
      .find((l) => l.startsWith("import") && l.includes("connector-scopes.json"));
    expect(line).toContain('with { type: "json" }');
  });
});
