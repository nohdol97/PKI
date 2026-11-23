// I02B-C56 (R55): the thread read answers a thread in time order. I02B-C57 (R55, negative): a message the read gate
// hides leaves no trace in the list or the participants, and a hidden or thread-less request is the 404 of a
// number nothing is stored under. Mutation check of this file (the per-message gate removed) is in the PR.
// All data is synthetic.
import { routes, type RouteName } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
import {
  createDerivativeRegistry,
  defaultScopePolicy,
  registerConnectorInstance,
  saveSourceRecord,
  userDecisions,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { dirTemplate, send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());
const TOKEN = "t".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const NOT_FOUND = { status: 404, body: { error: "not-found" } };
const hidingSecret = (): DerivativeRegistry =>
  createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
    policy: {
      ...defaultScopePolicy,
      allows: (scopes) => !scopes.some((s) => s?.includes("secret")),
    },
  });

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-thread-gate-"));
  seedDataDir(dir);
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A message of `thread`; its latest version's number is returned. */
function message(id: string, author: string, createdAt: string, thread: string, scope?: string[]) {
  saveSourceRecord(db, "c", {
    externalId: id,
    title: `제목 ${id}`,
    body: `본문 ${id}`,
    revision: 1,
    provenance: { author, threadId: thread, createdAt },
    ...(scope ? { accessScope: scope } : {}),
  });
  return db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
}
async function call(name: RouteName, body: unknown) {
  server ??= await startServer({
    token: TOKEN,
    allowedOrigins: ["http://localhost:5173"],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    decisions: userDecisions,
    registry: hidingSecret(),
  });
  const valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  return send(server.port, routes[name].path, valid, routes[name].method, body);
}

describe("sources.thread (I02B-C56, C57)", () => {
  it("answers the thread of a message in time order, with the participants", async () => {
    message("m2", "이", "2026-11-10T02:00:00Z", "th");
    const first = message("m1", "김", "2026-11-10T01:00:00Z", "th");
    message("other", "박", "2026-11-10T00:00:00Z", "elsewhere");
    const answer = await call("sourceThread", { versionId: first });
    expect(answer.status).toBe(200);
    const body = routes.sourceThread.response.parse(answer.body);
    expect(body.messages.map((m) => m.title)).toEqual(["제목 m1", "제목 m2"]);
    expect(body.messages[0]?.versionId).toBe(first);
    expect(body.participants).toEqual(["김", "이"]);
  });

  it("leaves a hidden message out of the list and the participants, and answers a hidden or thread-less request as a missing number", async () => {
    const open = message("m1", "공개인", "2026-11-10T01:00:00Z", "th");
    message("m2", "비밀인", "2026-11-10T02:00:00Z", "th", ["secret"]);
    const hiddenOnly = message("h1", "비밀둘", "2026-11-10T01:00:00Z", "th-hidden", ["secret"]);
    const noThread = saveSourceRecord(db, "c", { externalId: "plain", title: "t", body: "b" });
    expect(noThread.status).toBe("created");
    const plain = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;

    const shown = await call("sourceThread", { versionId: open });
    const text = JSON.stringify(shown.body);
    expect(routes.sourceThread.response.parse(shown.body).messages).toHaveLength(1);
    expect(text).not.toContain("비밀인");
    expect(text).not.toContain("제목 m2");
    for (const versionId of [hiddenOnly, plain, 99_999]) {
      expect(await call("sourceThread", { versionId })).toEqual(NOT_FOUND);
    }
  });
});
