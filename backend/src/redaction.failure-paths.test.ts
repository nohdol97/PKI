// V01-C5 `redaction.failure-paths` (V01-R13), the part T08 owns: a Provider that
// fails by echoing its input (error text, invalid output, a crafted error name)
// leaves the document and prompt canaries nowhere: not in the call results, the
// history rows, the API's activity answer, the log lines, or any file of the data
// directory; and no temporary file is left. The OpenAI-compatible Provider (T11) runs
// here against a fake HTTP server that echoes the request it got, in an error body
// and as output. The CLI Providers (T10) run against a fake CLI that fails by
// printing its stdin to stdout and stderr, or prints non-JSON.
import {
  ProviderError,
  routes,
  type StructuredRequest,
  type StructuredResponse,
} from "@pki/contracts";
import {
  CLI_PROFILES,
  createBroker,
  createCallRecorder,
  createEgressPolicy,
  createUserActionLedger,
  EXTRACT_SCHEMA_VERSION,
  OPENAI_BASE_URL_SETTING,
  OPENAI_MODEL_SETTING,
  TASKS,
} from "@pki/providers";
import {
  createClaudeCodeProvider,
  createCodexProvider,
  OpenAICompatibleProvider,
} from "@pki/providers/adapters";
import { registerConnectorInstance, saveSourceRecord, writeSetting } from "@pki/storage";
import {
  completion,
  FakeProvider,
  installFakeCli,
  newTempFilesContaining,
  send,
  startFakeOpenAI,
  tempEntries,
  type FakeHttpReply,
  type FakeHttpRequest,
} from "@pki/testkit";
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
/** The instructions the Broker sends with an extraction: a canary the CLI echoes back. */
const EXTRACT_INSTRUCTIONS = TASKS.extract[EXTRACT_SCHEMA_VERSION].instructions;
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
    const tempBefore = tempEntries();
    try {
      registerConnectorInstance(db, "fixtures", "test-fixtures");
      saveSourceRecord(db, "fixtures", {
        externalId: "x1",
        title: `합성 제목 ${DOC_CANARY}`,
        body: `합성 본문 ${DOC_CANARY}`,
      });
      // The server repeats the whole request body it received: in an error, then as output.
      let reply: (request: FakeHttpRequest) => FakeHttpReply = () => completion("{}");
      const http = await startFakeOpenAI((request) => reply(request));
      writeSetting(db, OPENAI_BASE_URL_SETTING, http.baseUrl);
      writeSetting(db, OPENAI_MODEL_SETTING, "synthetic-model");
      const egress = createEgressPolicy({ db, allowLoopbackHttp: true });
      egress.grant("openai-compatible", ["general"], {
        destination: http.host,
        policyVersion: egress.policyVersion(),
      });
      const openai = () =>
        new OpenAICompatibleProvider({
          db,
          secrets: {
            read: async () => ({ state: "present", value: "sk-synthetic" }),
            has: async () => "present",
            deleteOthers: async () => "done",
          },
          allowLoopbackHttp: true,
          egress,
        });
      const httpEcho = (request: FakeHttpRequest) => `${ECHO_MARKER} ${request.body}`;
      const ledger = createUserActionLedger();
      const results: unknown[] = [];
      const providers = [
        { provider: new EchoingError() },
        { provider: new EchoingPlainError() },
        { provider: new EchoingOutput() },
        {
          provider: openai(),
          reply: (r: FakeHttpRequest) => ({ status: 500, body: { error: httpEcho(r) } }),
        },
        {
          provider: openai(),
          reply: (r: FakeHttpRequest) => completion(JSON.stringify({ claims: httpEcho(r) })),
        },
      ];
      for (const { provider, reply: next } of providers) {
        if (next) reply = next;
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
              schemaVersion: 5,
              budget: { timeoutMs: 1000 },
              retryable: true,
            }),
          ),
        );
      }
      await http.close();
      // the echo really carried the canaries: this test would see a leak
      const sent = (providers[0]?.provider as EchoingError).requests[0];
      expect(sent && echo(sent)).toContain(DOC_CANARY);
      expect(sent && echo(sent)).toContain("Extract knowledge items");
      expect(http.requests).toHaveLength(4);
      for (const request of http.requests) {
        expect(httpEcho(request)).toContain(DOC_CANARY);
        expect(httpEcho(request)).toContain("Extract knowledge items");
      }
      expect(results).toMatchObject([
        { status: "failed", error: "provider-error", attempts: 3 },
        { status: "failed", error: "provider-error", attempts: 1 },
        { status: "failed", error: "invalid-output", attempts: 1 },
        { status: "failed", error: "provider-error", attempts: 3 },
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
      expect((activity.body as { calls: unknown[] }).calls).toHaveLength(9);

      const history = db.all("SELECT * FROM provider_calls");
      const texts = [
        JSON.stringify(results),
        JSON.stringify(history),
        JSON.stringify(activity.body),
        logged.join("\n"),
      ];
      for (const text of texts) {
        for (const canary of [DOC_CANARY, ECHO_MARKER, "Extract knowledge items"]) {
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
    const created = [...tempEntries()].filter((name) => !tempBefore.has(name));
    expect(created.filter((name) => name.includes(run))).toEqual([]);
    expect(newTempFilesContaining(tempBefore, ECHO_MARKER)).toEqual([]);
  });

  // four fake CLI runs, each a Node start: slow when the whole suite runs in parallel
  it(
    "for the CLI Providers: in results, history, logs, data files or temp files",
    { timeout: 60_000 },
    async () => {
      // the fake's own folder holds the marker in its configuration: made before the snapshot
      const fakeRoot = mkdtempSync(join(tmpdir(), "pki-redact-fake-"));
      const echoing = installFakeCli({ mode: "fail-echo", marker: ECHO_MARKER }, fakeRoot);
      const garbage = installFakeCli({ mode: "garbage" }, fakeRoot);
      const runs = mkdtempSync(join(tmpdir(), "pki-redact-runs-"));
      const db = openCanonicalDb(dir);
      const tempBefore = tempEntries();
      try {
        registerConnectorInstance(db, "fixtures", "test-fixtures");
        saveSourceRecord(db, "fixtures", {
          externalId: "x1",
          title: `합성 제목 ${DOC_CANARY}`,
          body: `합성 본문 ${DOC_CANARY}`,
        });
        const egress = createEgressPolicy({ db });
        for (const id of ["claude-code", "codex"] as const) {
          egress.grant(id, ["general"], {
            destination: `vendor:${id}`,
            policyVersion: egress.policyVersion(),
          });
        }
        const ledger = createUserActionLedger();
        const results: unknown[] = [];
        for (const fake of [echoing, garbage]) {
          for (const [id, create] of [
            ["claude-code", createClaudeCodeProvider],
            ["codex", createCodexProvider],
          ] as const) {
            const provider = create({ env: { PATH: fake.bin }, runsRoot: runs });
            const broker = createBroker({
              db,
              provider: () => provider,
              userActions: ledger.redeemer,
              candidates: { lookup: () => undefined },
              egress,
              execution: {
                decide: () => ({
                  run: true,
                  cli: {
                    profile: CLI_PROFILES[id].standard,
                    isolation: "verified",
                    model: "synthetic-model",
                  },
                }),
              },
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
                  schemaVersion: 5,
                  budget: { timeoutMs: 20_000 },
                  retryable: false,
                }),
              ),
            );
          }
        }
        // the CLI really received the canaries and echoed them: this test would see a leak
        expect(echoing.modelCalls()).toBe(2);
        expect(results).toMatchObject([
          { status: "failed", error: "provider-error" },
          { status: "failed", error: "provider-error" },
          { status: "failed", error: "provider-error" },
          { status: "failed", error: "provider-error" },
        ]);
        const texts = [
          JSON.stringify(results),
          JSON.stringify(db.all("SELECT * FROM provider_calls")),
          logged.join("\n"),
        ];
        for (const text of texts) {
          for (const canary of [DOC_CANARY, ECHO_MARKER, EXTRACT_INSTRUCTIONS]) {
            expect(text).not.toContain(canary);
          }
        }
        // every run's temporary folder is gone
        expect(readdirSync(runs)).toEqual([]);
      } finally {
        db.close();
        rmSync(runs, { recursive: true, force: true });
        echoing.dispose();
        garbage.dispose();
        rmSync(fakeRoot, { recursive: true, force: true });
      }
      for (const file of filesUnder(dir)) {
        expect(readFileSync(file).includes(ECHO_MARKER), file).toBe(false);
      }
      // other workers' entries may appear meanwhile; none may hold the input or the echo
      expect(newTempFilesContaining(tempBefore, DOC_CANARY)).toEqual([]);
      expect(newTempFilesContaining(tempBefore, ECHO_MARKER)).toEqual([]);
    },
  );

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
