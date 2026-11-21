// V01-C4 `provider.contract` for the OpenAI-compatible Provider (V01-R11), against a
// local fake HTTP server, plus what only an HTTP Provider must hold (spec "T08이
// 넘기는 것" 4): it sends only to the destination the Broker's decision named,
// re-reading the endpoint just before sending; `https` only (loopback `http` when
// allowed); no user info; no redirects; the key read from the secret store per call,
// under the name bound to the endpoint host, so a key never goes to another host.
import {
  isBackendReadableSecret,
  ProviderError,
  ProviderRateLimitError,
  type SecretRead,
  type SecretSource,
} from "@pki/contracts";
import { migrate, readSetting, writeSetting, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import {
  completion,
  providerContract,
  providerRequest,
  startFakeOpenAI,
  structuredRequest,
  type FakeHttpReply,
  type FakeOpenAIServer,
} from "@pki/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_BASE_URL_SETTING, OPENAI_MODEL_SETTING } from "../egress-policy.ts";
import { openaiKeySecretName } from "../secret-names.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";

const KEY = "sk-synthetic-test-key";
const MODEL = "synthetic-model";
const live = () => new AbortController().signal;

/**
 * A secret store double holding one key (or reporting missing/unavailable): for the
 * key of `forHost` only, or, without it, for any OpenAI key name. `asked` records
 * reads of the value, `checked` presence checks.
 */
function secretsOf(read: SecretRead = { state: "present", value: KEY }, forHost?: string) {
  const asked: string[] = [];
  const checked: string[] = [];
  const holds = (name: string) =>
    forHost === undefined ? isBackendReadableSecret(name) : name === openaiKeySecretName(forHost);
  const source: SecretSource & { asked: string[]; checked: string[]; current: SecretRead } = {
    asked,
    checked,
    current: read,
    async read(name) {
      asked.push(name);
      return holds(name) ? source.current : { state: "missing" };
    },
    async has(name) {
      checked.push(name);
      return holds(name) ? source.current.state : "missing";
    },
  };
  return source;
}

function dbWith(baseUrl: string | undefined, model: string | undefined): SqlDriver {
  const db = openBetterSqlite3(":memory:");
  migrate(db);
  if (baseUrl !== undefined) writeSetting(db, OPENAI_BASE_URL_SETTING, baseUrl);
  if (model !== undefined) writeSetting(db, OPENAI_MODEL_SETTING, model);
  return db;
}

/**
 * An egress policy double that allows whatever host the endpoint names now, at
 * policy version "test" (the contract bundle's), until `withdraw()`.
 */
function egressOf(db: SqlDriver) {
  let allowed = true;
  return {
    withdraw: () => void (allowed = false),
    decide: () => {
      const raw = readSetting(db, OPENAI_BASE_URL_SETTING);
      if (!allowed || raw === undefined || !URL.canParse(raw)) {
        return { allowed: false, reason: "no-consent" } as const;
      }
      return { allowed: true, destination: new URL(raw).host, policyVersion: "test" } as const;
    },
  };
}

const dbs: SqlDriver[] = [];
function provider(
  baseUrl: string | undefined,
  options: { secrets?: SecretSource; allowLoopbackHttp?: boolean; model?: string | undefined } = {},
) {
  const db = dbWith(baseUrl, "model" in options ? options.model : MODEL);
  dbs.push(db);
  const egress = egressOf(db);
  const p = new OpenAICompatibleProvider({
    db,
    secrets: options.secrets ?? secretsOf(),
    allowLoopbackHttp: options.allowLoopbackHttp ?? true,
    egress,
  });
  return Object.assign(p, { db, egress });
}

let server: FakeOpenAIServer;
let failing: FakeOpenAIServer;
beforeAll(async () => {
  server = await startFakeOpenAI();
  failing = await startFakeOpenAI(() => ({ status: 500, body: { error: "backend down" } }));
});
afterAll(async () => {
  await server.close();
  await failing.close();
});
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

providerContract("openai-compatible (fake HTTP server)", () => provider(server.baseUrl), {
  modelCalls: () => server.completions(),
  failing: () => provider(failing.baseUrl),
  destination: () => server.host,
});

describe("OpenAICompatibleProvider", () => {
  let scripted: FakeOpenAIServer;
  let reply: (body: Record<string, unknown>) => FakeHttpReply | Promise<FakeHttpReply>;
  beforeEach(async () => {
    reply = () => completion("ok");
    scripted = await startFakeOpenAI((request) => reply(JSON.parse(request.body || "{}")));
  });
  afterEach(() => scripted.close());

  it("posts a chat completion with the model, the key and the documents as data", async () => {
    const p = provider(scripted.baseUrl);
    const response = await p.generate(providerRequest("r:1", scripted.host), live());
    expect(response).toEqual({ text: "ok" });
    const [sent] = scripted.requests;
    expect(sent?.method).toBe("POST");
    expect(sent?.path).toBe("/v1/chat/completions");
    expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(sent?.body ?? "{}");
    expect(body.model).toBe(MODEL);
    expect(body.messages[0]).toEqual({ role: "system", content: "Reply with one word." });
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain('"title":"title"');
    expect(body.messages[1].content).toContain('"body":"body"');
    expect(body).not.toHaveProperty("response_format");
  });

  it("asks for the JSON Schema and returns the parsed output", async () => {
    reply = () => completion('{"reply":"yes"}');
    const p = provider(scripted.baseUrl);
    const request = structuredRequest("r:1", scripted.host);
    expect(await p.generateStructured(request, live())).toEqual({ output: { reply: "yes" } });
    const body = JSON.parse(scripted.requests[0]?.body ?? "{}");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "output", schema: request.outputSchema },
    });
  });

  it("caps the output tokens at the request's budget", async () => {
    const p = provider(scripted.baseUrl);
    const request = {
      ...providerRequest("r:1", scripted.host),
      budget: { timeoutMs: 1000, maxOutputTokens: 64 },
    };
    await p.generate(request, live());
    expect(JSON.parse(scripted.requests[0]?.body ?? "{}").max_tokens).toBe(64);
  });

  describe("sends only to the decided destination", () => {
    it("refuses when the endpoint's host changed after the decision, sending nothing", async () => {
      const p = provider(scripted.baseUrl);
      const other = await startFakeOpenAI();
      try {
        // the decision named `scripted`; the setting now points at `other`
        writeSetting(p.db, OPENAI_BASE_URL_SETTING, other.baseUrl);
        const error = await p
          .generate(providerRequest("r:1", scripted.host), live())
          .catch((e) => e);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({ retryable: false, message: "destination-mismatch" });
        expect(other.requests).toEqual([]);
        expect(scripted.requests).toEqual([]);
      } finally {
        await other.close();
      }
    });

    it("re-reads the endpoint after the key, just before sending", async () => {
      const other = await startFakeOpenAI();
      try {
        const db = dbWith(scripted.baseUrl, MODEL);
        dbs.push(db);
        // the setting changes while the key is being fetched from the shell
        const p = new OpenAICompatibleProvider({
          db,
          allowLoopbackHttp: true,
          egress: egressOf(db),
          secrets: {
            read: async () => {
              writeSetting(db, OPENAI_BASE_URL_SETTING, other.baseUrl);
              return { state: "present", value: KEY };
            },
            has: async () => "present",
          },
        });
        const error = await p
          .generate(providerRequest("r:1", scripted.host), live())
          .catch((e) => e);
        expect(error).toMatchObject({ retryable: false, message: "destination-mismatch" });
        expect(other.requests).toEqual([]);
        expect(scripted.requests).toEqual([]);
      } finally {
        await other.close();
      }
    });

    it("asks the egress policy again just before sending; a consent withdrawn meanwhile stops it", async () => {
      const secrets = secretsOf();
      const read = secrets.read.bind(secrets);
      // the consent is revoked while the key is being fetched from the shell
      secrets.read = async (name) => (p.egress.withdraw(), read(name));
      const p = provider(scripted.baseUrl, { secrets });
      const error = await p.generate(providerRequest("r:1", scripted.host), live()).catch((e) => e);
      expect(error).toMatchObject({ retryable: false, message: "consent-withdrawn" });
      expect(scripted.requests).toEqual([]);
    });

    it("refuses when the policy version changed since the Broker's decision", async () => {
      const p = provider(scripted.baseUrl);
      const request = providerRequest("r:1", scripted.host);
      const stale = { ...request, egress: { ...request.egress, policyVersion: "pv-older" } };
      const error = await p.generate(stale, live()).catch((e) => e);
      expect(error).toMatchObject({ retryable: false, message: "consent-withdrawn" });
      expect(scripted.requests).toEqual([]);
    });

    it.each([
      ["a different port", (host: string) => host.replace(/:\d+$/, ":1")],
      ["another host", () => "api.synthetic.example"],
      ["an empty destination", () => ""],
    ])("refuses a decision naming %s", async (_name, decided) => {
      const p = provider(scripted.baseUrl);
      const error = await p
        .generateStructured(structuredRequest("r:1", decided(scripted.host)), live())
        .catch((e) => e);
      expect(error).toMatchObject({ retryable: false, message: "destination-mismatch" });
      expect(scripted.requests).toEqual([]);
    });

    it("refuses loopback http when the build does not allow it", async () => {
      const p = provider(scripted.baseUrl, { allowLoopbackHttp: false });
      const error = await p.generate(providerRequest("r:1", scripted.host), live()).catch((e) => e);
      expect(error).toMatchObject({ retryable: false, message: "insecure-endpoint" });
      expect(scripted.requests).toEqual([]);
    });

    it.each([
      ["http to a non-loopback host", "http://api.synthetic.example/v1", "api.synthetic.example"],
      ["ftp", "ftp://api.synthetic.example/v1", "api.synthetic.example"],
      ["user info", "https://u:p@api.synthetic.example/v1", "api.synthetic.example"],
      ["user info on loopback", "http://u:p@127.0.0.1:9/v1", "127.0.0.1:9"],
    ])("refuses an endpoint with %s before any network use", async (_name, url, host) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const p = provider(url);
        const error = await p.generate(providerRequest("r:1", host), live()).catch((e) => e);
        expect(error).toMatchObject({ retryable: false, message: "insecure-endpoint" });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("refuses when the endpoint is not set", async () => {
      const p = provider(undefined);
      const error = await p.generate(providerRequest("r:1", "x"), live()).catch((e) => e);
      expect(error).toMatchObject({ retryable: false, message: "destination-unavailable" });
    });

    it("follows no redirect, so the body never reaches another host", async () => {
      const elsewhere = await startFakeOpenAI();
      try {
        reply = () => ({
          status: 307,
          headers: { location: `${elsewhere.baseUrl}/chat/completions` },
          body: "",
        });
        const p = provider(scripted.baseUrl);
        const error = await p
          .generate(providerRequest("r:1", scripted.host), live())
          .catch((e) => e);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({ message: "http-307", retryable: false });
        expect(elsewhere.requests).toEqual([]);
      } finally {
        await elsewhere.close();
      }
    });
  });

  describe("the key", () => {
    it("is read from the secret store for every call, never kept", async () => {
      const secrets = secretsOf();
      const p = provider(scripted.baseUrl, { secrets });
      await p.generate(providerRequest("r:1", scripted.host), live());
      secrets.current = { state: "present", value: "sk-rotated" };
      await p.generate(providerRequest("r:2", scripted.host), live());
      expect(scripted.requests.map((r) => r.headers.authorization)).toEqual([
        `Bearer ${KEY}`,
        "Bearer sk-rotated",
      ]);
      const name = openaiKeySecretName(scripted.host);
      expect(secrets.asked).toEqual([name, name]);
    });

    it.each([
      ["missing", { state: "missing" } as const, "api-key-missing", "unauthenticated"],
      ["unavailable", { state: "unavailable" } as const, "secret-store-unavailable", "unknown"],
    ])(
      "when %s, nothing is sent and the Provider is unavailable",
      async (_n, read, reason, auth) => {
        const p = provider(scripted.baseUrl, { secrets: secretsOf(read) });
        const error = await p
          .generate(providerRequest("r:1", scripted.host), live())
          .catch((e) => e);
        expect(error).toMatchObject({ retryable: false, message: reason });
        expect(scripted.requests).toEqual([]);
        expect(await p.checkHealth()).toEqual({ state: "unavailable", reason });
        expect(await p.checkAuthentication()).toBe(auth);
      },
    );

    it("is not read when the destination check already refuses", async () => {
      const secrets = secretsOf();
      const p = provider(scripted.baseUrl, { secrets });
      await p.generate(providerRequest("r:1", "elsewhere.example"), live()).catch(() => undefined);
      expect(secrets.asked).toEqual([]);
    });
  });

  describe("the key is bound to the endpoint host it was entered for", () => {
    it("is not sent to a new host, even with consent for it, until entered for that host", async () => {
      const other = await startFakeOpenAI();
      try {
        // the key was entered while the endpoint was `scripted`
        const secrets = secretsOf({ state: "present", value: KEY }, scripted.host);
        const p = provider(scripted.baseUrl, { secrets });
        await p.generate(providerRequest("r:1", scripted.host), live());
        // the endpoint moves to `other` and the Broker's decision now names it
        writeSetting(p.db, OPENAI_BASE_URL_SETTING, other.baseUrl);
        const error = await p.generate(providerRequest("r:2", other.host), live()).catch((e) => e);
        expect(error).toMatchObject({ message: "api-key-missing", retryable: false });
        expect(other.requests).toEqual([]);
        expect(await p.checkHealth()).toEqual({ state: "unavailable", reason: "api-key-missing" });
        expect(secrets.asked).toEqual([
          openaiKeySecretName(scripted.host),
          openaiKeySecretName(other.host),
        ]);
      } finally {
        await other.close();
      }
    });
  });

  it("checks health and authentication by presence only, never reading the value", async () => {
    const secrets = secretsOf();
    const p = provider(scripted.baseUrl, { secrets });
    expect(await p.checkHealth()).toEqual({ state: "ok" });
    // a stored key is not proof the server takes it; telling would mean sending it
    expect(await p.checkAuthentication()).toBe("unknown");
    expect(secrets.asked).toEqual([]);
    expect(secrets.checked).toEqual([
      openaiKeySecretName(scripted.host),
      openaiKeySecretName(scripted.host),
    ]);
  });

  describe("failures become ProviderErrors without the server's words", () => {
    const echo = "ECHO sk-synthetic-test-key secret document text";
    it.each([
      [500, true],
      [503, true],
      [408, true],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
    ])("status %i → retryable %s", async (status, retryable) => {
      reply = () => ({ status, body: { error: { message: echo } } });
      const p = provider(scripted.baseUrl);
      const error = await p.generate(providerRequest("r:1", scripted.host), live()).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ retryable, message: `http-${status}` });
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain("ECHO");
    });

    it("reports a rate limit with the wait the server asked for", async () => {
      reply = () => ({ status: 429, headers: { "retry-after": "7" }, body: { error: echo } });
      const p = provider(scripted.baseUrl);
      const error = await p.generate(providerRequest("r:1", scripted.host), live()).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderRateLimitError);
      expect(error.retryAfterMs).toBe(7000);
    });

    it("reports a rate limit without a usable wait as undefined", async () => {
      reply = () => ({ status: 429, headers: { "retry-after": "soon" }, body: "" });
      const p = provider(scripted.baseUrl);
      const error = await p.generate(providerRequest("r:1", scripted.host), live()).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderRateLimitError);
      expect(error.retryAfterMs).toBeUndefined();
    });

    it.each([
      ["not JSON", { status: 200, body: `not json ${echo}` }],
      ["no choices", { status: 200, body: { choices: [] } }],
      ["non-string content", { status: 200, body: { choices: [{ message: { content: 42 } }] } }],
    ])("rejects a malformed response (%s)", async (_name, r) => {
      reply = () => r;
      const p = provider(scripted.baseUrl);
      const error = await p.generate(providerRequest("r:1", scripted.host), live()).catch((e) => e);
      expect(error).toMatchObject({ message: "malformed-response", retryable: true });
    });

    it("rejects structured output that is not JSON", async () => {
      reply = () => completion(`${echo} not json`);
      const p = provider(scripted.baseUrl);
      const error = await p
        .generateStructured(structuredRequest("r:1", scripted.host), live())
        .catch((e) => e);
      expect(error).toMatchObject({ message: "malformed-response", retryable: true });
      expect(error.message).not.toContain("ECHO");
    });

    it("rejects an oversized response without keeping it", async () => {
      reply = () => completion("x".repeat(3 * 1024 * 1024));
      const p = provider(scripted.baseUrl);
      const error = await p.generate(providerRequest("r:1", scripted.host), live()).catch((e) => e);
      expect(error).toMatchObject({ message: "response-too-large", retryable: false });
    });

    it("reports a connection lost mid-body as a retryable network error", async () => {
      reply = () => ({ ...completion("x".repeat(64 * 1024)), truncate: true });
      const p = provider(scripted.baseUrl);
      const error = await p.generate(providerRequest("r:1", scripted.host), live()).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ message: "network-error", retryable: true });
    });

    it("reports a refused connection as retryable", async () => {
      const gone = await startFakeOpenAI();
      await gone.close();
      const p = provider(gone.baseUrl);
      const error = await p.generate(providerRequest("r:1", gone.host), live()).catch((e) => e);
      expect(error).toMatchObject({ message: "network-error", retryable: true });
    });
  });

  it("cancels a running request by its request ID", async () => {
    reply = () => new Promise<FakeHttpReply>(() => undefined);
    const p = provider(scripted.baseUrl);
    const call = p.generate(providerRequest("r:9", scripted.host), live());
    await vi.waitFor(() => expect(scripted.requests).toHaveLength(1));
    await p.cancel("r:9");
    await expect(call).rejects.toThrow();
  });

  it("checks health and detection from the settings alone", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(await provider(scripted.baseUrl).checkHealth()).toEqual({ state: "ok" });
      expect(await provider(scripted.baseUrl).detect()).toEqual({ installed: true });
      expect(await provider(undefined).detect()).toEqual({ installed: false });
      expect(await provider(undefined).checkHealth()).toEqual({
        state: "unavailable",
        reason: "destination-unavailable",
      });
      expect(await provider("http://api.synthetic.example/v1").checkHealth()).toEqual({
        state: "unavailable",
        reason: "insecure-endpoint",
      });
      expect(await provider(scripted.baseUrl, { model: undefined }).checkHealth()).toEqual({
        state: "unavailable",
        reason: "model-missing",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("is an external HTTP Provider with structured output and cancel", () => {
    const p = provider(scripted.baseUrl);
    expect([p.id, p.transport]).toEqual(["openai-compatible", "http"]);
    expect(p.getCapabilities()).toEqual({
      structuredOutput: true,
      cancel: true,
      egress: "external",
    });
  });
});
