// S02-T01 `graph.api` (catalogue part, S02-R25, C1): `GET /api/knowledge-schema` answers the catalogue's edition and,
// for every name, its place, whether it can be used now and whether the stored rule is the catalogue's; the answer
// matches the contract schema, needs the token, and follows the type definitions (a retired one is unusable, a
// rule the user changed no longer matches). A reserved name is refused over the check route with its code.
// All data is synthetic.
import {
  KNOWLEDGE_SCHEMA,
  KnowledgeSchemaResponseSchema,
  routes,
  type RouteName,
} from "@pki/contracts";
import {
  applyOntologyChange,
  saveSourceRecord,
  registerConnectorInstance,
  userDecisions,
  type SqlDriver,
} from "@pki/storage";
import { send } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb, productAdapters, productEgress } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer, type RunningServer } from "./server.ts";

const TOKEN = "k".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let valid: Record<string, string>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-knowledge-schema-api-"));
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start() {
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress: productEgress(db),
    ...productAdapters(dir),
    decisions: userDecisions,
  });
  valid = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
}
const call = (name: RouteName, body?: unknown, headers = valid) =>
  send((server as RunningServer).port, routes[name].path, headers, routes[name].method, body);
const schema = async () => {
  const res = await call("knowledgeSchema");
  expect(res.status).toBe(200);
  return KnowledgeSchemaResponseSchema.parse(res.body);
};
const entryOf = (list: Awaited<ReturnType<typeof schema>>, name: string) => {
  const found = list.entries.filter((e) => e.name === name);
  expect(found).toHaveLength(1);
  return found[0] as (typeof list.entries)[number];
};

describe("graph.api (catalogue)", () => {
  it("answers the edition and every name with its place, usable and rule-matching, matching the contract", async () => {
    await start();
    const list = await schema();
    expect(list.edition).toBe(KNOWLEDGE_SCHEMA.edition);
    expect(list.entries.filter((e) => e.category === "knowledge-type")).toHaveLength(19);
    expect(list.entries.filter((e) => e.category === "relation-type")).toHaveLength(15);
    expect(list.entries.filter((e) => e.category === "fact-kind")).toHaveLength(22);
    const catalogued = [
      ...KNOWLEDGE_SCHEMA.knowledgeTypes,
      ...KNOWLEDGE_SCHEMA.relationTypes,
      ...KNOWLEDGE_SCHEMA.factKinds,
    ];
    expect(list.entries.map((e) => [e.name, e.place])).toEqual(
      catalogued.map((e) => [e.name, e.place]),
    );
    // The database is migrated to edition 2 (S03-T04's migration seeds the analytical names and widens the
    // four rules): every name that is a type definition is usable and has the catalogue's rule.
    for (const e of list.entries) {
      const stored = e.place === "type-definition";
      expect({ name: e.name, usable: e.usable, ruleMatches: e.ruleMatches }).toEqual({
        name: e.name,
        usable: stored ? true : null,
        ruleMatches: stored ? true : null,
      });
    }
    expect(entryOf(list, "Document")).toMatchObject({ place: "sources" });
    expect(entryOf(list, "SUPERSEDES")).toMatchObject({ place: "assertion-links" });
  });

  it("needs the token, as every route", async () => {
    await start();
    const res = await call("knowledgeSchema", undefined, { host: valid.host as string });
    expect(res.status).toBe(401);
  });

  it("reports a retired definition as unusable and a rule the user changed as not the catalogue's", async () => {
    await start();
    const retired = userDecisions.ontology.change(db, {
      op: "retire",
      elementKind: "relation-type",
      name: "BELONGS_TO",
    });
    expect(retired.status).toBe("applied");
    const changed = userDecisions.ontology.change(db, {
      op: "change-rule",
      elementKind: "relation-type",
      name: "DEPENDS_ON",
      rule: {
        elementKind: "relation-type",
        subjectTypes: ["Project"],
        objectTypes: ["Project"],
        symmetric: false,
      },
    });
    expect(changed.status).toBe("applied");
    const list = await schema();
    expect(entryOf(list, "BELONGS_TO")).toMatchObject({ usable: false, ruleMatches: true });
    expect(entryOf(list, "DEPENDS_ON")).toMatchObject({ usable: true, ruleMatches: false });
    expect(entryOf(list, "RELATED_TO")).toMatchObject({ usable: true, ruleMatches: true });
  });

  it("answers with the catalogue's names only, never a name a user or a source added", async () => {
    const saved = saveSourceRecord(db, "c", { externalId: "d", title: "t", body: "b" });
    if (saved.status !== "created") throw new Error(saved.status);
    // a user's definition and a candidate from a source: neither name is in the answer
    const bogus = userDecisions.ontology.change(db, {
      op: "add",
      name: "QzCandidateName",
      rule: { elementKind: "item-type" },
    });
    expect(bogus.status).toBe("applied");
    applyOntologyChange(
      db,
      { op: "add", name: "QzOther", rule: { elementKind: "item-type" } },
      "extraction",
      {
        sourceId: saved.sourceId,
        version: saved.version,
      },
    );
    await start();
    const body = JSON.stringify((await call("knowledgeSchema")).body);
    expect(body).not.toContain("Qz");
  });

  it("refuses a reserved name over the check route, with the code and without the name", async () => {
    await start();
    const res = await call("ontologyCheck", {
      op: "add",
      name: "Supports",
      rule: {
        elementKind: "relation-type",
        subjectTypes: ["Project"],
        objectTypes: ["System"],
        symmetric: false,
      },
    });
    expect(routes.ontologyCheck.response.parse(res.body)).toMatchObject({
      schemaErrors: ["reserved-name"],
      applicable: false,
    });
    expect(JSON.stringify(res.body)).not.toContain("Supports");
  });
});
