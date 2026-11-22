// I04-C1 `invalidate.record` (I04-R4, I04-T01): after a deletion propagated through
// the registry (double kinds), the invalidation record holds the right count per
// kind and the status API returns them; neither the row nor the response holds the
// fixture's title, body, quote or external identifier.
import { routes } from "@pki/contracts";
import {
  createDerivativeRegistry,
  migrate,
  registerConnectorInstance,
  saveSourceRecord,
  type DerivativeKind,
  type Layer,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { MemoryVectorIndex, send } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedLegacyTombstone } from "@pki/testkit";
import { productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer } from "./server.ts";

const TOKEN = "i".repeat(43);
const AT = "2026-11-22T00:00:00.000Z";
const CANARIES = {
  title: "qvt-title-canary",
  body: "jhw-body-canary",
  quote: "pxk-quote-canary",
  externalId: "zmr-external-canary",
  instance: "bfn-instance-canary",
};
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  db.exec("CREATE TABLE quotes (id INTEGER PRIMARY KEY, source_id INTEGER, quote TEXT)");
});
afterEach(() => db.close());

/** A kind of quote rows, one per source: a deletion removes the source's rows. */
function quotes(kind: string, layer: Layer): DerivativeKind {
  return {
    kind,
    layer,
    references: [],
    storage: "canonical",
    dataPaths: [],
    affected: (tx, change) =>
      tx.all("SELECT id FROM quotes WHERE source_id = ?", [change.sourceId]).map((r) => ({
        ref: { kind, id: String(r.id) },
        lineage: [{ sourceId: change.sourceId, version: 1 }],
      })),
    lineage: () => [],
    invalidate: ({ tx }, snapshot) => {
      let removed = 0;
      for (const { ref } of snapshot) {
        removed += tx.run("DELETE FROM quotes WHERE id = ?", [Number(ref.id)]).changes;
      }
      return { removed, recomputed: kind === "insight-double" ? 1 : 0 };
    },
  };
}

async function status() {
  const server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    vectorIndex: new MemoryVectorIndex(),
    embedder: null,
    connectors,
    db,
    dataDirectory: "/synthetic/data",
    egress: productEgress(db),
  });
  try {
    return await send(server.port, routes.status.path, {
      host: `127.0.0.1:${server.port}`,
      authorization: `Bearer ${TOKEN}`,
    });
  } finally {
    await server.close();
  }
}

describe("invalidate.record", () => {
  it("counts per kind in the record and the status API, with no fixture text", async () => {
    registerConnectorInstance(db, CANARIES.instance, "test-fixtures");
    const saved = saveSourceRecord(db, CANARIES.instance, {
      externalId: CANARIES.externalId,
      title: CANARIES.title,
      body: CANARIES.body,
    });
    if (saved.status !== "created") throw new Error(saved.status);
    for (let i = 0; i < 3; i++) {
      db.run("INSERT INTO quotes (source_id, quote) VALUES (?, ?)", [
        saved.sourceId,
        CANARIES.quote,
      ]);
    }
    const registry = createDerivativeRegistry({
      kinds: [quotes("relation-double", "knowledge"), quotes("insight-double", "insight")],
      policy: {
        compare: () => "equal",
        strictest: () => null,
        combinable: () => true,
        allows: () => true,
      },
      now: () => AT,
    });
    db.transaction(() => {
      seedLegacyTombstone(db, {
        sourceId: saved.sourceId,
        version: 1,
        at: AT,
        reason: "user-deleted",
      });
      registry.propagate(db, {
        kind: "user-deleted",
        sourceId: saved.sourceId,
        coversVersion: 1,
        lastRevision: null,
      });
    });
    const changeSeq = db.all("SELECT change_seq FROM revisions")[0]?.change_seq;

    const res = await status();
    expect(res.status).toBe(200);
    const body = routes.status.response.parse(res.body);
    expect(body.invalidations).toEqual({
      recent: [
        {
          changeSeq,
          sourceId: saved.sourceId,
          changeKind: "user-deleted",
          // relation-double removed all three rows; nothing was left for insight-double
          removedByKind: { "relation-double": 3, "insight-double": 0 },
          recomputedByKind: { "relation-double": 0, "insight-double": 1 },
          at: AT,
        },
      ],
      scopePolicyDrops: 0,
    });

    const record = JSON.stringify(db.all("SELECT * FROM invalidations"));
    const response = JSON.stringify(res.body);
    for (const canary of Object.values(CANARIES)) {
      expect(record).not.toContain(canary);
      expect(response).not.toContain(canary);
    }
  });

  it("is an empty list before any propagation", async () => {
    expect(routes.status.response.parse((await status()).body).invalidations).toEqual({
      recent: [],
      scopePolicyDrops: 0,
    });
  });
});
