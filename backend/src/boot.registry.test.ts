// I04-T04 (composition wiring, review B1): the registry boot builds reaches every product path that
// runs it. A registry that differs from the default (one more kind that notes every change it is asked
// about, and a `lineage` that notes every row it is asked about) is injected into `bootBackend`; each
// path must show it: the screen's deletion (server entries), a Connector's sync (connector manager
// entries), the JSONL import (importer entries) and the extraction's candidate lineage (runner registry).
// Dropping the argument on any of the four leaves the path on the default registry and its test red.
import { routes, type ChangeSet, type Connector } from "@pki/contracts";
import { NO_POLICY_YET, createProductRegistry } from "@pki/knowledge-engine";
import {
  createDerivativeRegistry,
  insertItem,
  registerConnectorInstance,
  saveSourceRecord,
  type DerivativeKind,
  type DerivativeRegistry,
} from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import type { ConnectorSet } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "r".repeat(43);
const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const GOLDEN = resolve(import.meta.dirname, "../../eval/golden/sources/mail.jsonl");

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-registry-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** The product's registry plus a spy kind, and a `lineage` that notes the kinds it was asked about. */
function spied() {
  const changes: string[] = [];
  const lineageKinds: string[] = [];
  const spy: DerivativeKind = {
    kind: "spy",
    layer: "delivery",
    references: [],
    storage: "canonical",
    dataPaths: [],
    lineage: () => [],
    affected: (_tx, change) => {
      changes.push(change.kind);
      return [];
    },
    invalidate: () => ({ removed: 0, recomputed: 0 }),
  };
  const base = createProductRegistry({ policy: NO_POLICY_YET });
  const registry = createDerivativeRegistry({
    kinds: [...base.kinds, spy],
    policy: NO_POLICY_YET,
  });
  const wrapped: DerivativeRegistry = {
    ...registry,
    lineage: (db, ref) => {
      lineageKinds.push(ref.kind);
      return registry.lineage(db, ref);
    },
  };
  return { changes, lineageKinds, registry: wrapped };
}

async function boot(registry: DerivativeRegistry, connectors?: ConnectorSet) {
  booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    registry,
    ...(connectors ? { connectors } : {}),
  });
  const { port } = booted.server;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    db: booted.db,
    post: (path: string, body: unknown) => send(port, path, headers, "POST", body),
  };
}

const revoking = (): Connector => {
  const page: ChangeSet = {
    changes: [
      {
        kind: "access-revoked",
        namespace: "",
        externalId: "x",
        revision: 2,
        at: "2026-11-21T00:00:00Z",
      },
    ],
    nextCursor: "1",
    hasMore: false,
  };
  return {
    manifest: {
      type: "rv",
      schemaVersion: 2,
      capabilities: {
        incremental: true,
        deletes: true,
        accessScope: false,
        fullRescan: true,
        deletionsOnRescan: false,
      },
    },
    initialize: async () => {},
    healthCheck: async () => ({ state: "ok" }),
    getChanges: async () => page,
    getDocument: async () => null,
  };
};

describe("the registry boot builds reaches the product paths", () => {
  it("the screen's deletion (server entries)", async () => {
    const { changes, registry } = spied();
    const { db, post } = await boot(registry);
    registerConnectorInstance(db, "c", "test-fixtures");
    saveSourceRecord(db, "c", { externalId: "x", title: "x", body: "본문" });
    const res = await post(routes.deleteSource.path, {
      connectorId: "c",
      namespace: "",
      externalId: "x",
    });
    expect(res.body).toEqual({ outcome: "deleted" });
    expect(changes).toEqual(["user-deleted"]);
  });

  it("a Connector's sync (connector manager entries)", async () => {
    const { changes, registry } = spied();
    const { db, post } = await boot(registry, {
      instances: [{ id: "rv", kind: "rv", config: {} }],
      kinds: { rv: revoking },
    });
    registerConnectorInstance(db, "rv", "rv");
    saveSourceRecord(db, "rv", { externalId: "x", title: "x", body: "본문" });
    await post(routes.syncConnector.path, { connectorId: "rv" });
    expect(changes).toEqual(["access-revoked"]);
  });

  it("the JSONL import (importer entries)", async () => {
    const { changes, registry } = spied();
    const { post } = await boot(registry);
    const res = await post(routes.importJsonl.path, { text: readFileSync(GOLDEN, "utf8") });
    expect(res.status).toBe(200);
    expect(changes).toContain("source-deleted");
  });

  it("the extraction's candidate lineage (runner registry)", async () => {
    const { lineageKinds, registry } = spied();
    const { db, post } = await boot(registry);
    insertItem(db, {
      type: "Project",
      name: "미리내 프로젝트",
      epistemic: "explicit",
      status: "candidate",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    });
    await post(routes.importJsonl.path, {
      text: readFileSync(resolve(FIXTURES, "v02-mail.jsonl"), "utf8"),
    });
    await vi.waitFor(() => expect(lineageKinds).toContain("item"));
  });
});
