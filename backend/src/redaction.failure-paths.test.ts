// V01-C5 `redaction.failure-paths` (V01-R13), the part T08 owns: a Provider that
// fails by echoing its input (error text, invalid output, a crafted error name)
// leaves the document and prompt canaries nowhere: not in the call results, the
// history rows, the API's activity answer, the log lines, or any file of the data
// directory; and no temporary file is left. The CLI (T10) and HTTP (T11) Providers
// add their own echoing fakes to this case when they land.
import {
  ProviderError,
  routes,
  type StructuredRequest,
  type StructuredResponse,
} from "@pki/contracts";
import {
  createBroker,
  createCallRecorder,
  createEgressPolicy,
  createUserActionLedger,
  OPENAI_BASE_URL_SETTING,
} from "@pki/providers";
import { registerConnectorInstance, saveSourceRecord, writeSetting } from "@pki/storage";
import { FakeProvider, send } from "@pki/testkit";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCanonicalDb, productAdapters } from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import { startServer } from "./server.ts";

const TOKEN = "r".repeat(43);
const run = randomUUID().slice(0, 8);
/** Only in the stored source: it may legitimately sit in the DB's sources table. */
const DOC_CANARY = `DOC-CANARY-${run}`;
/** Only in what a failing Provider returns: it must appear in no file at all. */
const ECHO_MARKER = `ECHO-MARKER-${run}`;
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };

/** Fails by repeating the request's instructions and documents, as a CLI or server may. */
const echo = (request: StructuredRequest) =>
  `${ECHO_MARKER} ${request.input.instructions} ${request.input.untrustedDocuments
    .map((d) => `${d.title} ${d.body}`)
    .join(" ")}`;

class EchoingError extends FakeProvider {
  override async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.requests.push(request);
    throw new ProviderError(echo(request), { retryable: true });
  }
}
class EchoingPlainError extends FakeProvider {
  override async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    const error = new Error(echo(request));
    error.name = echo(request);
    throw error;
  }
}
class EchoingOutput extends FakeProvider {
  override async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    return { output: { claims: echo(request) } };
  }
}

let dir: string;
let logged: string[];
let spies: { mockRestore(): void }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-redact-"));
  logged = [];
  const keep = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  spies = [
    vi.spyOn(console, "error").mockImplementation(keep),
    vi.spyOn(console, "warn").mockImplementation(keep),
    vi.spyOn(console, "log").mockImplementation(keep),
    vi.spyOn(console, "info").mockImplementation(keep),
    vi.spyOn(console, "debug").mockImplementation(keep),
  ];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe("failure paths leave no input behind", () => {
  it("in results, history, the activity API, logs, data files or temp files", async () => {
    const db = openCanonicalDb(dir);
    const tempBefore = new Set(readdirSync(tmpdir()));
    try {
      registerConnectorInstance(db, "fixtures", "test-fixtures");
      saveSourceRecord(db, "fixtures", {
        externalId: "x1",
        title: `합성 제목 ${DOC_CANARY}`,
        body: `합성 본문 ${DOC_CANARY}`,
      });
      writeSetting(db, OPENAI_BASE_URL_SETTING, "https://api.synthetic.example/v1");
      const egress = createEgressPolicy({ db });
      egress.grant("openai-compatible", ["general"], {
        destination: "api.synthetic.example",
        policyVersion: egress.policyVersion(),
      });
      const ledger = createUserActionLedger();
      const results: unknown[] = [];
      const providers = [new EchoingError(), new EchoingPlainError(), new EchoingOutput()];
      for (const provider of providers) {
        const broker = createBroker({
          db,
          provider: () => provider,
          userActions: ledger.redeemer,
          candidates: { lookup: () => undefined },
          egress,
          execution: { decide: () => ({ run: true }) },
          recorder: createCallRecorder(db),
          clock: { now: () => 0, sleep: async () => undefined },
        });
        results.push(
          await ledger.issuer.during((userActionId) =>
            broker.call({
              taskKind: "extract",
              sourceVersionIds: ["1"],
              candidateItemIds: [],
              origin: { userActionId },
              schemaVersion: 1,
              budget: { timeoutMs: 1000 },
              retryable: true,
            }),
          ),
        );
      }
      // the echo really carried the canaries: this test would see a leak
      const sent = (providers[0] as EchoingError).requests[0];
      expect(sent && echo(sent)).toContain(DOC_CANARY);
      expect(sent && echo(sent)).toContain("Extract the factual claims");
      expect(results).toMatchObject([
        { status: "failed", error: "provider-error", attempts: 3 },
        { status: "failed", error: "provider-error", attempts: 1 },
        { status: "failed", error: "invalid-output", attempts: 1 },
      ]);

      const server = await startServer({
        token: TOKEN,
        allowedOrigins: [],
        connectors,
        db,
        dataDirectory: dir,
        egress,
        ...productAdapters(dir),
      });
      const activity = await send(server.port, routes.activity.path, {
        host: `127.0.0.1:${server.port}`,
        authorization: `Bearer ${TOKEN}`,
      });
      await server.close();
      expect((activity.body as { calls: unknown[] }).calls).toHaveLength(5);

      const history = db.all("SELECT * FROM provider_calls");
      const texts = [
        JSON.stringify(results),
        JSON.stringify(history),
        JSON.stringify(activity.body),
        logged.join("\n"),
      ];
      for (const text of texts) {
        for (const canary of [DOC_CANARY, ECHO_MARKER, "Extract the factual claims"]) {
          expect(text).not.toContain(canary);
        }
      }
    } finally {
      db.close();
    }
    // the DB, its journal files and anything else in the data directory
    for (const file of filesUnder(dir)) {
      expect(readFileSync(file).includes(ECHO_MARKER), file).toBe(false);
    }
    const created = readdirSync(tmpdir()).filter((name) => !tempBefore.has(name));
    expect(created.filter((name) => name.includes(run))).toEqual([]);
    for (const name of created) {
      // other workers' temp files may appear meanwhile; none may hold the echo
      const path = join(tmpdir(), name);
      try {
        for (const file of filesUnder(path)) {
          expect(readFileSync(file).includes(ECHO_MARKER)).toBe(false);
        }
      } catch {
        // a sibling's directory removed while we looked, or a plain file: not ours
      }
    }
  });

  it("logs a failing route by name and known error class only", async () => {
    const db = openCanonicalDb(dir);
    try {
      const egress = createEgressPolicy({ db });
      const server = await startServer({
        token: TOKEN,
        allowedOrigins: [],
        connectors,
        db,
        dataDirectory: dir,
        egress: {
          ...egress,
          overview: () => {
            const error = new Error(`${ECHO_MARKER} ${DOC_CANARY}`);
            error.name = ECHO_MARKER;
            throw error;
          },
        },
        ...productAdapters(dir),
      });
      const res = await send(server.port, routes.consents.path, {
        host: `127.0.0.1:${server.port}`,
        authorization: `Bearer ${TOKEN}`,
      });
      await server.close();
      expect(res).toEqual({ status: 500, body: { error: "internal-error" } });
      expect(logged.map((l) => JSON.parse(l))).toEqual([
        { event: "route-failed", route: "consents", error: "other" },
      ]);
      expect(logged.join("\n")).not.toContain(ECHO_MARKER);
    } finally {
      db.close();
    }
  });
});
