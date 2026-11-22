// I01-C2 `scope.claimed-grade` (I01-R15) through the booted backend (I01-T06 handoff 10①): what an
// import leaves (`scope_claimed = 1`, the claimed scope, the instance's configured scope) is what the
// Broker grades. The build's scope file is replaced by a map the test holds (none ships); the policy
// and the scope -> class mapping are test doubles honoured in a test build only.
import { routes } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
import { writeDefaultProvider, type ScopeGrading } from "@pki/providers";
import {
  addEvidence,
  createDerivativeRegistry,
  defaultScopePolicy,
  insertItem,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  type AccessScope,
  type ScopeComparison,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { FakeProvider, send } from "@pki/testkit";
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
const { openCanonicalDb, productCalls, productEgress } = await import("./composition.ts");
const { NO_SECRET_STORE } = await import("./secret-sources.ts");

const TOKEN = "m".repeat(43);
const MAIL = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"), "utf8").split(
    "\n",
  )[0] as string,
) as Record<string, unknown>;

const RANK: Record<string, number> = { open: 1, team: 2, secret: 3 };
const compare = (a: AccessScope, b: AccessScope): ScopeComparison => {
  if (a === null || b === null) return a === b ? "equal" : a === null ? "stricter" : "looser";
  const [x, y] = [
    Math.max(...a.map((l) => RANK[l] ?? 99)),
    Math.max(...b.map((l) => RANK[l] ?? 99)),
  ];
  return x === y ? "equal" : x > y ? "stricter" : "looser";
};
const policy: ScopePolicy = { ...defaultScopePolicy, compare };
const registry = () =>
  createDerivativeRegistry({ kinds: createProductRegistry({ policy }).kinds, policy });

let asked: string[];
let answer: "general" | "synthetic";
const grading: ScopeGrading = {
  grade: (scope) => {
    asked.push(`grade:${scope?.join("+") ?? "null"}`);
    return answer as "general";
  },
  strictest: (classes) => {
    asked.push(`strictest:[${classes.join(",")}]`);
    return answer as "general";
  },
};

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-claimed-import-"));
  held.scopes = new Map();
  asked = [];
  answer = "general";
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function boot(injected: boolean) {
  booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    ...(injected ? { registry: registry(), scopeGrading: grading } : {}),
  });
  const { port } = booted.server;
  const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
  return {
    db: booted.db,
    post: (path: string, body: unknown) => send(port, path, headers, "POST", body),
  };
}

/** One JSONL line: the template mail line with its own identity, scope and content. */
const line = (o: {
  id: string;
  instance: string;
  scope: string[];
  body?: string;
  version?: number;
}) =>
  JSON.stringify({
    ...MAIL,
    external_id: o.id,
    connector_instance_id: o.instance,
    access_scope: o.scope,
    ...(o.version === undefined ? {} : { version: o.version }),
  });

const rows = (db: SqlDriver, instance: string) =>
  db.all(
    `SELECT s.scope_claimed, s.access_scope, c.configured_scope, c.kind FROM sources s
       JOIN connector_instances c ON c.id = s.connector_instance_id WHERE c.id = ?`,
    [instance],
  );
const versionOf = (db: SqlDriver, instance: string, externalId?: string) =>
  String(
    db.all(
      `SELECT v.id FROM source_versions v JOIN sources s ON s.id = v.source_id
        WHERE s.connector_instance_id = ? ${externalId ? "AND s.external_id = ?" : ""}
        ORDER BY v.id DESC LIMIT 1`,
      externalId ? [instance, externalId] : [instance],
    )[0]?.id,
  );

/** A Broker on the booted database, the test policy and mapping, and a Provider consent allows. */
function broker(db: SqlDriver, injected: boolean) {
  const egress = productEgress(db);
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  const extractor = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer: () => ({ items: [], facts: [], relations: [] }),
  });
  writeDefaultProvider(db, "local-model");
  const calls = productCalls(db, egress, {
    providers: [extractor],
    ...(injected ? { registry: registry(), scopeGrading: grading } : {}),
  });
  return {
    extractor,
    call: (ids: string[], candidates: string[] = []) =>
      calls.issuer.during((userActionId) =>
        calls.broker.call({
          origin: { userActionId },
          taskKind: "extract",
          sourceVersionIds: ids,
          candidateItemIds: candidates,
          schemaVersion: 2,
          budget: { timeoutMs: 1000 },
          retryable: false,
        }),
      ),
  };
}

/** An item whose only evidence is `versionId` (its lineage is that version). */
function itemCiting(db: SqlDriver, versionId: string): string {
  const item = insertItem(db, {
    type: "Project",
    name: "미리내 프로젝트",
    epistemic: "explicit",
    status: "candidate",
    validAt: null,
    observedAt: "2026-11-21T00:00:00Z",
  });
  const fact = saveFact(db, {
    itemId: item,
    kind: "target_date",
    value: "2026-12-05",
    epistemic: "explicit",
    status: "candidate",
    validAt: null,
    observedAt: "2026-11-21T00:00:00Z",
  }).id;
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [Number(versionId)])[0]
    ?.body as string;
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: Number(versionId),
    start: 0,
    end: 3,
    quote: [...body].slice(0, 3).join(""),
  });
  return String(item);
}

describe("an import leaves a claimed source that carries its instance's configured scope", () => {
  it("POST /api/imports: scope_claimed = 1, the claimed scope, and the configured scope before any Broker call", async () => {
    held.scopes = new Map([["imp-api", ["team"]]]);
    const { db, post } = await boot(false);
    expect(rows(db, "imp-api")).toEqual([]);
    const res = await post(routes.imports.path, {
      instanceId: "imp-api",
      content: line({ id: "a1", instance: "imp-api", scope: ["open"] }),
    });
    expect(res.status).toBe(200);
    expect(rows(db, "imp-api")).toEqual([
      {
        scope_claimed: 1,
        access_scope: '["open"]',
        configured_scope: '["team"]',
        kind: "jsonl-import",
      },
    ]);
  });

  it("POST /api/import/jsonl (the V02 route): the same, per instance the file names", async () => {
    held.scopes = new Map([["imp-v02", ["secret"]]]);
    const { db, post } = await boot(false);
    const res = await post(routes.importJsonl.path, {
      text: [
        line({ id: "b1", instance: "imp-v02", scope: ["open"] }),
        line({ id: "c1", instance: "imp-other", scope: ["team"] }),
      ].join("\n"),
    });
    expect(res.status).toBe(200);
    expect(rows(db, "imp-v02")).toEqual([
      {
        scope_claimed: 1,
        access_scope: '["open"]',
        configured_scope: '["secret"]',
        kind: "jsonl-import",
      },
    ]);
    // an instance the file does not configure is unknown
    expect(rows(db, "imp-other")).toEqual([
      { scope_claimed: 1, access_scope: '["team"]', configured_scope: null, kind: "jsonl-import" },
    ]);
  });
});

describe("the Broker grades an imported source by its claim and the configured scope", () => {
  it("public default (nothing configured, public mapping and policy): the request proceeds, general", async () => {
    const { db, post } = await boot(false);
    await post(routes.imports.path, {
      instanceId: "imp-pub",
      content: line({ id: "p1", instance: "imp-pub", scope: ["open"] }),
    });
    const b = broker(db, false);
    const result = await b.call([versionOf(db, "imp-pub")]);
    expect(result.status).toBe("ok");
    expect(b.extractor.requests.at(-1)?.dataClassification).toBe("general");
  });

  it("a claim looser than the configured scope: both scopes' classes are asked, directly and through a derived item's lineage", async () => {
    held.scopes = new Map([["imp-api", ["team"]]]);
    const { db, post } = await boot(true);
    await post(routes.imports.path, {
      instanceId: "imp-api",
      content: line({ id: "a1", instance: "imp-api", scope: ["open"] }),
    });
    const version = versionOf(db, "imp-api");
    const b = broker(db, true);
    asked = [];
    expect((await b.call([version])).status).toBe("ok");
    expect(asked).toEqual(["grade:open", "grade:team", "strictest:[general,general]"]);

    const item = itemCiting(db, version);
    // the claimed source reached only through the item's lineage; a plain direct source keeps the input non-empty
    saveSourceRecord(db, "imp-api", { externalId: "plain", title: "t", body: "본문" });
    asked = [];
    expect((await b.call([versionOf(db, "imp-api", "plain")], [item])).status).toBe("ok");
    expect(asked).toEqual([
      "grade:null",
      "grade:open",
      "grade:team",
      "strictest:[general,general]",
    ]);
  });

  it("the booted backend's own Broker (the extraction of the imported version) uses the registry's policy and the mapping", async () => {
    held.scopes = new Map([["imp-api", ["team"]]]);
    const { post } = await boot(true);
    await post(routes.imports.path, {
      instanceId: "imp-api",
      content: line({ id: "a1", instance: "imp-api", scope: ["open"] }),
    });
    await vi.waitFor(() =>
      expect(asked).toEqual(["grade:open", "grade:team", "strictest:[general,general]"]),
    );
  });

  it("a mapping that answers synthetic: scope-unjudged, no Provider call", async () => {
    held.scopes = new Map([["imp-api", ["team"]]]);
    const { db, post } = await boot(true);
    await post(routes.imports.path, {
      instanceId: "imp-api",
      content: line({ id: "a1", instance: "imp-api", scope: ["open"] }),
    });
    answer = "synthetic";
    const b = broker(db, true);
    expect(await b.call([versionOf(db, "imp-api")])).toEqual({
      status: "rejected",
      reason: "scope-unjudged",
    });
    expect(b.extractor.requests).toEqual([]);
  });

  it("legacy identity: a source written into ANOTHER import instance is graded by its owner's configured scope", async () => {
    held.scopes = new Map([
      ["imp-a-owner", ["team"]],
      ["imp-z-request", ["secret"]],
    ]);
    // the owner exists from an earlier run: the start copies the file's scope into its row
    const earlier = openCanonicalDb(dir);
    registerConnectorInstance(earlier, "imp-a-owner", "jsonl-import");
    saveSourceRecord(earlier, "imp-a-owner", {
      externalId: "legacy",
      title: "옛 제목",
      body: "옛 본문",
    });
    earlier.close();
    const { db, post } = await boot(true);
    // the line names imp-a-owner as its own instance; the request instance is imp-z-request
    const res = await post(routes.imports.path, {
      instanceId: "imp-z-request",
      content: line({ id: "legacy", instance: "imp-a-owner", scope: ["open"], version: 2 }),
    });
    expect(res.status).toBe(200);
    expect(rows(db, "imp-z-request")).toEqual([]);
    const [owner] = rows(db, "imp-a-owner");
    expect(owner).toMatchObject({ scope_claimed: 1, access_scope: '["open"]' });
    const b = broker(db, true);
    asked = [];
    expect((await b.call([versionOf(db, "imp-a-owner", "legacy")])).status).toBe("ok");
    expect(asked).toEqual(["grade:open", "grade:team", "strictest:[general,general]"]);
  });
});
