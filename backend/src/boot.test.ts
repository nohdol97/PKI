// The started backend (boot.ts, shared by dev.ts and shell.ts) binds the Broker to
// the connection-test API (V01-R21) and the background setting to the settings API,
// default off (V01-C7 cli-background-default). The product binds the two CLI Providers
// (V01-T10) and the OpenAI-compatible one (V01-T11) and calls only the user's default:
// none before one is picked. Picked, the OpenAI-compatible Provider without an endpoint
// is blocked by the egress decision; with endpoint, model, key and consent it reaches
// the endpoint, through the same egress instance the consent API wrote.
import { routes, type SecretSource } from "@pki/contracts";
import { CLI_PROFILES, DEFAULT_PROVIDER_SETTING, openaiKeySecretName } from "@pki/providers";
import {
  registerConnectorInstance,
  registerJob,
  saveSourceRecord,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { createClaudeCodeProvider } from "@pki/providers/adapters";
import {
  completion,
  FakeProvider,
  installFakeCli,
  processAlive,
  send,
  startFakeOpenAI,
  type FakeHttpReply,
} from "@pki/testkit";
import { connect } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { bootBackend, closeProviders } from "./boot.ts";
import { openCanonicalDb } from "./composition.ts";
import { BACKOFF_MAX_MS } from "./schedule.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "t".repeat(43);
let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-boot-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("bootBackend", () => {
  it("serves the connection test and the background setting, default off", async () => {
    booted = await bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
    });
    const { port } = booted.server;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    const get = (path: string) => send(port, path, headers);
    const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);

    expect(booted.providers.map((p) => p.id)).toEqual([
      "claude-code",
      "codex",
      "openai-compatible",
    ]);
    expect((await post(routes.connectionTest.path, { acknowledgeUnverified: true })).body).toEqual({
      outcome: "blocked",
      reason: "no-provider",
      isolation: null,
    });
    await post(routes.setDefaultProvider.path, { providerId: "openai-compatible" });
    expect((await post(routes.connectionTest.path, { acknowledgeUnverified: true })).body).toEqual({
      outcome: "blocked",
      reason: "destination-unavailable",
      isolation: null,
    });
    expect((await get(routes.executionSettings.path)).body).toEqual({ cliBackground: false });
    expect((await post(routes.setExecutionSettings.path, { cliBackground: true })).body).toEqual({
      cliBackground: true,
    });
    expect((await get(routes.executionSettings.path)).body).toEqual({ cliBackground: true });
    expect((await post(routes.setExecutionSettings.path, { cliBackground: false })).body).toEqual({
      cliBackground: false,
    });
  });

  it("sweeps at start the CLI run folders a backend that is gone left in the data directory", async () => {
    const root = join(dir, "cli-runs");
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    const stale = join(root, "99999999.crashed"); // a PID beyond pid_max: never alive
    const live = join(root, `${process.pid}.running`);
    mkdirSync(stale);
    mkdirSync(live);
    booted = await bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
    });
    expect([existsSync(stale), existsSync(live)]).toEqual([false, true]);
  });

  it("runs a connection test through the bound OpenAI-compatible Provider", async () => {
    const endpoint = await startFakeOpenAI();
    const key = openaiKeySecretName(endpoint.host);
    const secrets: SecretSource = {
      read: async (n) =>
        n === key ? { state: "present", value: "sk-boot" } : { state: "missing" },
      has: async (n) => (n === key ? "present" : "missing"),
      deleteOthers: async () => "done",
    };
    try {
      booted = await bootBackend({ dataDir: dir, token: TOKEN, allowedOrigins: [], secrets });
      const { port } = booted.server;
      const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
      const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);
      await post(routes.writeSettings.path, {
        openaiCompatible: { baseUrl: endpoint.baseUrl, model: "synthetic-model" },
      });
      await post(routes.setDefaultProvider.path, { providerId: "openai-compatible" });
      const consents = await send(port, routes.consents.path, headers);
      await post(routes.grantConsent.path, {
        providerId: "openai-compatible",
        allowedClasses: ["synthetic"],
        destination: endpoint.host,
        policyVersion: (consents.body as { policyVersion: string }).policyVersion,
      });
      expect(
        (await post(routes.connectionTest.path, { acknowledgeUnverified: false })).body,
      ).toEqual({
        outcome: "ok",
        reason: null,
        isolation: null,
      });
      expect(endpoint.requests.map((r) => r.headers.authorization)).toEqual(["Bearer sk-boot"]);
    } finally {
      await endpoint.close();
    }
  });

  it("runs the job runner: imported sources are extracted, held until the endpoint and consent exist", async () => {
    const endpoint = await startFakeOpenAI();
    const key = openaiKeySecretName(endpoint.host);
    const secrets: SecretSource = {
      read: async (n) =>
        n === key ? { state: "present", value: "sk-boot" } : { state: "missing" },
      has: async (n) => (n === key ? "present" : "missing"),
      deleteOthers: async () => "done",
    };
    try {
      booted = await bootBackend({ dataDir: dir, token: TOKEN, allowedOrigins: [], secrets });
      const { db } = booted;
      const { port } = booted.server;
      const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
      const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);
      const fixtures = resolve(import.meta.dirname, "../../fixtures");
      const text = ["v02-mail.jsonl", "v02-wiki.jsonl", "v02-messenger.jsonl"]
        .map((f) => readFileSync(join(fixtures, f), "utf8"))
        .join("\n");
      expect((await post(routes.importJsonl.path, { text })).body).toMatchObject({ created: 3 });
      // K01: the Wiki's own `wiki-build` jobs are not what this test's jobs are about
      const jobs = () =>
        db.all(
          // the wiki build and the notification scan are queued by the runner itself (K01-R5, P02-R3)
          "SELECT status, reason FROM jobs WHERE kind NOT IN ('wiki-build', 'notify') ORDER BY id",
        );
      // no default Provider chosen yet (V01-T10): nothing is called
      await vi.waitFor(() =>
        expect(jobs()).toEqual(Array(3).fill({ status: "held", reason: "no-provider" })),
      );
      // choosing one judges the held jobs again
      await post(routes.setDefaultProvider.path, { providerId: "openai-compatible" });
      await vi.waitFor(() =>
        expect(jobs()).toEqual(
          Array(3).fill({ status: "held", reason: "destination-unavailable" }),
        ),
      );

      await post(routes.writeSettings.path, {
        openaiCompatible: { baseUrl: endpoint.baseUrl, model: "synthetic-model" },
      });
      // still blocked: no consent yet (imported files are "general")
      await vi.waitFor(() =>
        expect(jobs()).toEqual(Array(3).fill({ status: "held", reason: "no-consent" })),
      );
      const consents = await send(port, routes.consents.path, headers);
      await post(routes.grantConsent.path, {
        providerId: "openai-compatible",
        allowedClasses: ["general"],
        destination: endpoint.host,
        policyVersion: (consents.body as { policyVersion: string }).policyVersion,
      });
      // the fake endpoint answers no extraction: asked twice per job, then dead-lettered
      await vi.waitFor(() =>
        expect(jobs()).toEqual(Array(3).fill({ status: "dead_letter", reason: "invalid-output" })),
      );
      expect(endpoint.requests).toHaveLength(6);
    } finally {
      await endpoint.close();
    }
  });

  describe("the runner's lifecycle", () => {
    /** Writes jobs into the data directory before any backend runs on it. */
    function seed(jobs: { status: "queued" | "held"; reason?: string }[]) {
      const db: SqlDriver = openCanonicalDb(dir);
      try {
        writeSetting(db, DEFAULT_PROVIDER_SETTING, "openai-compatible"); // the user's default
        registerConnectorInstance(db, "seeded", "jsonl-import");
        jobs.forEach((job, i) => {
          const saved = saveSourceRecord(db, "seeded", {
            externalId: `s${i}`,
            title: "t",
            body: `seeded ${i}`,
          });
          if (saved.status !== "created") throw new Error("expected a version");
          registerJob(db, {
            kind: "extract",
            sourceId: saved.sourceId,
            fenceVersion: saved.version,
          });
          if (job.status === "held") {
            db.run("UPDATE jobs SET status = 'held', reason = ? WHERE source_id = ?", [
              job.reason ?? null,
              saved.sourceId,
            ]);
          }
        });
      } finally {
        db.close();
      }
    }
    // K01: the Wiki's own `wiki-build` jobs are not the runner jobs these tests are about
    const jobsOf = (db: SqlDriver) =>
      db.all(
        // the wiki build and the notification scan are queued by the runner itself (K01-R5, P02-R3)
        "SELECT status, reason FROM jobs WHERE kind NOT IN ('wiki-build', 'notify') ORDER BY id",
      );

    it("starts the runner: a job left queued before the start runs with no other trigger", async () => {
      seed([{ status: "queued" }]);
      booted = await bootBackend({
        dataDir: dir,
        token: TOKEN,
        allowedOrigins: [],
        secrets: NO_SECRET_STORE,
      });
      const { db } = booted;
      await vi.waitFor(() =>
        expect(jobsOf(db)).toEqual([{ status: "held", reason: "destination-unavailable" }]),
      );
    });

    it("releases held jobs at start under new egress rules, except one held for size", async () => {
      seed([
        { status: "held", reason: "no-consent" },
        { status: "held", reason: "source-too-large" },
      ]);
      booted = await bootBackend({
        dataDir: dir,
        token: TOKEN,
        allowedOrigins: [],
        secrets: NO_SECRET_STORE,
      });
      const { db } = booted;
      await vi.waitFor(() =>
        expect(jobsOf(db)).toEqual([
          { status: "held", reason: "destination-unavailable" }, // judged again
          { status: "held", reason: "source-too-large" },
        ]),
      );
    });

    it("closes only after the running job has closed", async () => {
      let answer!: (reply: FakeHttpReply) => void;
      const gate = new Promise<FakeHttpReply>((resolve) => (answer = resolve));
      const endpoint = await startFakeOpenAI(() => gate);
      const key = openaiKeySecretName(endpoint.host);
      const secrets: SecretSource = {
        read: async (n) =>
          n === key ? { state: "present", value: "sk-boot" } : { state: "missing" },
        has: async (n) => (n === key ? "present" : "missing"),
        deleteOthers: async () => "done",
      };
      try {
        booted = await bootBackend({ dataDir: dir, token: TOKEN, allowedOrigins: [], secrets });
        const { db } = booted;
        const { port } = booted.server;
        const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
        const post = (path: string, body: unknown) => send(port, path, headers, "POST", body);
        await post(routes.setDefaultProvider.path, { providerId: "openai-compatible" });
        await post(routes.writeSettings.path, {
          openaiCompatible: { baseUrl: endpoint.baseUrl, model: "synthetic-model" },
        });
        const consents = await send(port, routes.consents.path, headers);
        await post(routes.grantConsent.path, {
          providerId: "openai-compatible",
          allowedClasses: ["general"],
          destination: endpoint.host,
          policyVersion: (consents.body as { policyVersion: string }).policyVersion,
        });
        const line = readFileSync(
          resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"),
          "utf8",
        );
        await post(routes.importJsonl.path, { text: line });
        await vi.waitFor(() => expect(endpoint.completions()).toBe(1)); // the job is in its call

        const server = booted.server;
        booted = undefined; // closed here, not again in afterEach
        let closed = false;
        const closing = server.close().then(() => (closed = true));
        // the API stops listening first; the close must still wait for the job
        await vi.waitFor(
          () =>
            new Promise<void>((ok, fail) => {
              const socket = connect(port, "127.0.0.1");
              socket.once("connect", () => (socket.destroy(), fail(new Error("still listening"))));
              socket.once("error", () => ok());
            }),
        );
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        expect(closed).toBe(false);
        expect(jobsOf(db)).toEqual([{ status: "running", reason: null }]);

        answer(
          completion(
            JSON.stringify({ items: [], facts: [], relations: [], terms: [], definitions: [] }),
          ),
        );
        await closing;
        expect(jobsOf(db)).toEqual([{ status: "succeeded", reason: null }]);
        db.close();
      } finally {
        await endpoint.close();
      }
    });
  });
});

describe("closeProviders (backend shutdown, V01-T10)", () => {
  it("ends a CLI call still running, its whole tree, before the backend exits", async () => {
    // its own folder: afterEach removes `dir` before onTestFinished runs the leak check
    const fake = installFakeCli({ mode: "stubborn" });
    onTestFinished(async () => {
      // leak check: whatever the shutdown left is killed, and fails the test
      expect(await fake.leftovers()).toEqual([]);
      fake.dispose();
    });
    const provider = createClaudeCodeProvider({ env: { PATH: fake.bin }, killGraceMs: 200 });
    const call = provider
      .generateStructured(
        {
          requestId: "shutdown:1",
          taskKind: "connection-test",
          trigger: "user",
          dataClassification: "synthetic",
          egress: { allowed: true, destination: "vendor:claude-code", policyVersion: "pv" },
          schemaVersion: 1,
          budget: { timeoutMs: 60_000 },
          retryable: false,
          input: { instructions: "x", untrustedDocuments: [], candidates: [] },
          execution: {
            profile: CLI_PROFILES["claude-code"].standard,
            isolation: "verified",
            model: "synthetic-model",
          },
          outputSchema: { type: "object" },
        },
        new AbortController().signal,
      )
      .catch((e: unknown) => e);
    while (fake.spawned().length === 0) await new Promise((r) => setTimeout(r, 20));
    await closeProviders([provider], 10_000);
    expect(await call).toBeInstanceOf(Error);
    const pids = fake.spawned().flatMap((s) => [s.child, s.grandchild]);
    const end = Date.now() + 5_000;
    while (pids.some(processAlive) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(pids.filter(processAlive)).toEqual([]);
  }, 30_000);

  it("does not wait past its limit for a Provider whose close never ends", async () => {
    const stuck = Object.assign(new FakeProvider(), { close: () => new Promise<void>(() => {}) });
    const started = Date.now();
    await closeProviders([stuck, new FakeProvider()], 200);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("bootBackend scheduler (I03-T08, R22)", () => {
  it("starts the scheduler check at boot, wakes the runner for what it registers and stops it on close", async () => {
    // a run time left far ahead by a clock that went back: the start check pulls it back
    const seed = openCanonicalDb(dir);
    const far = registerJob(seed, { kind: "connector-sync", target: "c1" });
    if (!far.registered) throw new Error("register");
    seed.run("UPDATE jobs SET run_after = ? WHERE id = ?", [
      Date.now() + 9 * 86_400_000,
      far.job.id,
    ]);
    seed.close();

    booted = await bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
    });
    const pulled = booted.db.all("SELECT run_after FROM jobs WHERE id = ?", [far.job.id])[0]
      ?.run_after as number;
    expect(pulled).toBeLessThanOrEqual(Date.now() + BACKOFF_MAX_MS);
    expect(booted.scheduler.isRunning()).toBe(true);

    const wake = vi.spyOn(booted.runner, "wake");
    const { schedule } = booted.scheduler.ensureSchedule({
      kind: "connector-sync",
      target: "c2",
      period: { kind: "hourly" },
    });
    booted.scheduler.runNow(schedule.id);
    expect(wake).toHaveBeenCalled();

    const closing = booted;
    booted = undefined;
    await closing.server.close();
    expect(closing.scheduler.isRunning()).toBe(false);
    closing.db.close();
  });
});
