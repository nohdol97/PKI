// I01-R24 with I04-T08's read gate: what POST /api/imports and the V02 import route store shows in the
// gated Sources list and search of a booted backend, and a tombstone hides it. Synthetic data only.
import { routes } from "@pki/contracts";
import { send } from "@pki/testkit";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "i".repeat(43);
let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-import-booted-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const line = (patch: Record<string, unknown>) => {
  const content = String(patch.content ?? "합성 등대 본문");
  return JSON.stringify({
    id: "syn-1",
    source_type: "wiki",
    external_id: "p1",
    title: "합성 제목",
    content,
    author: "a@example.test",
    participants: [],
    thread_id: "",
    source_url: "https://wiki.example.test/1",
    created_at: "2026-11-01T09:00:00+09:00",
    updated_at: "2026-11-02T09:00:00+09:00",
    content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    version: 1,
    access_scope: ["org:all"],
    metadata: {},
    connector_instance_id: "conn-w",
    operation: "upsert",
    schema_version: "1",
    ...patch,
  });
};

it("both import routes' sources are in the gated list and search, and a tombstone hides them", async () => {
  booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
  });
  const { server } = booted;
  const h = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  const list = async () =>
    (
      (await send(server.port, routes.sources.path, h)).body as {
        sources: { externalId: string }[];
      }
    ).sources.map((s) => s.externalId);
  const find = async (query: string) =>
    (
      (await send(server.port, routes.searchSources.path, h, "POST", { query })).body as {
        sources: { externalId: string }[];
      }
    ).sources.map((s) => s.externalId);

  const api = await send(server.port, routes.imports.path, h, "POST", {
    instanceId: "api-inst",
    content: line({ external_id: "via-api" }),
  });
  expect(api.status).toBe(200);
  const v02 = await send(server.port, routes.importJsonl.path, h, "POST", {
    text: line({ external_id: "via-v02", connector_instance_id: "v02-inst" }),
  });
  expect(v02.status).toBe(200);
  expect((await list()).sort()).toEqual(["via-api", "via-v02"]);
  expect((await find("등대")).sort()).toEqual(["via-api", "via-v02"]);

  const del = await send(server.port, routes.imports.path, h, "POST", {
    instanceId: "api-inst",
    content: line({ external_id: "via-api", operation: "delete", content: "", version: 2 }),
  });
  expect(del.body).toMatchObject({ tombstoned: 1 });
  expect(await list()).toEqual(["via-v02"]);
  expect(await find("등대")).toEqual(["via-v02"]);
});
