// P02-T2 `notify.flow` (P02-C1a, C1b read part, C3c ②, R14, R16; reviewer FU2/FU4 of T1): a synthetic JSONL goes in
// through the import, the extraction runs and the scan's "run now" writes the lines; the API then lists them with
// the Insight's words, the digest read computes its content when asked, the user's actions change the lines, and
// every read goes through the read gate: a hidden or deleted Insight leaves the feed, the digest and the count.
import { routes, type RouteName, type RouteRequest, type RouteResponse } from "@pki/contracts";
import { createProductRegistry } from "@pki/knowledge-engine";
import { DEFAULT_PROVIDER_SETTING, type EgressControls } from "@pki/providers";
import {
  defaultScopePolicy,
  listNotifications,
  readNotifySettings,
  registerConnectorInstance,
  userDecisions,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { FakeProvider, fixtureExtraction, dirTemplate, send } from "@pki/testkit";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openCanonicalDb,
  productAdapters,
  productCalls,
  productEgress,
  productImporter,
  productRunner,
} from "./composition.ts";
import type { ConnectorManager } from "./connectors.ts";
import type { JobRunner } from "./job-runner.ts";
import { createNotifyOutbox } from "./notify-outbox.ts";
import { ensureNotifySchedules } from "./notify-schedules.ts";
import { fakeChannel, NOW, notifyNow, seedInsight } from "./notify.test-support.ts";
import { createScheduler } from "./scheduler.ts";
import { startServer, type RunningServer } from "./server.ts";

const seedDataDir = dirTemplate((path) => openCanonicalDb(path).close());

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const read = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8").trim();
const TOKEN = "n".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const IMPORT = ["v02-mail", "v02-wiki", "v02-messenger"].map((n) => read(`${n}.jsonl`)).join("\n");
const NO_QUIET = { enabled: false, start: "22:00", end: "08:00" };
const DAY = 86_400_000;

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let runner: JobRunner | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-notify-flow-"));
  seedDataDir(dir);
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(async () => {
  await server?.close();
  await runner?.stop();
  server = undefined;
  runner = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function consent(egress: EgressControls) {
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  const granted = egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/** The product's runner and scheduler (the three `notify` periods), the import and the API over one database. */
async function backend() {
  const extraction = fixtureExtraction();
  const egress = productEgress(db);
  const provider = new FakeProvider({ id: "local-model", transport: "http", answer: extraction });
  writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id);
  const calls = productCalls(db, egress, { providers: [provider] });
  const run = productRunner(db, calls.broker, { policyFingerprint: calls.policyFingerprint });
  runner = run;
  consent(egress);
  const scheduler = createScheduler({ db, onRegistered: () => void run.wake() });
  ensureNotifySchedules(scheduler);
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    decisions: userDecisions,
    now: () => Date.parse(NOW),
    onRunConditionsChanged: () => void run.wake(),
    ...productAdapters(dir),
  });
  const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  const port = server.port;
  const call = async <Name extends RouteName>(name: Name, body?: RouteRequest<Name>) => {
    const route = routes[name];
    const res = await send(port, route.path, headers, route.method, body);
    return { status: res.status, body: res.body as RouteResponse<Name> };
  };
  const importer = productImporter(db, { runner: run });
  /** A period's "run now", then the runner takes the job. */
  const runPeriod = async (target: "scan" | "daily" | "weekly") => {
    const schedule = scheduler.list().find((s) => s.kind === "notify" && s.target === target);
    scheduler.runNow(schedule?.id as number);
    await run.wake();
  };
  return {
    call,
    runPeriod,
    importIn: async (text: string) => (await importer(text), await run.wake()),
  };
}

const jsonl = (patch: Record<string, unknown>) => {
  const record = { ...(JSON.parse(read("v02-mail.jsonl")) as object), ...patch } as {
    content: string;
  };
  const hash = createHash("sha256").update(record.content, "utf8").digest("hex");
  return JSON.stringify({ ...record, content_hash: `sha256:${hash}` });
};

describe("notify.flow: the feed and the shell's count (P02-C1a)", () => {
  it("lists an important Insight as sent with its words and actions, a low-confidence one as digest, and tells the shell of the sent one only", async () => {
    const { call, runPeriod, importIn } = await backend();
    await importIn(IMPORT);
    // the imported Insight is made important (a date within a week, full confidence); a second one has low confidence
    const soon = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
    db.run("UPDATE insights SET urgency_date = ?, confidence = 100 WHERE state = 'active'", [soon]);
    seedInsight(db, { name: "낮은 신뢰", confidence: 30 });
    await call("setNotificationSettings", { quietHours: NO_QUIET });

    await runPeriod("scan");
    const registry = createProductRegistry({ policy: defaultScopePolicy });
    const { channel, sent } = fakeChannel();
    createNotifyOutbox({ db, registry, channel }).flush();

    const feed = (await call("notifications")).body;
    const sentLine = feed.lines.find((l) => l.status === "sent");
    expect(sentLine?.insight).toMatchObject({ epistemic: "inferred" });
    expect(sentLine?.insight.evidenceCount).toBeGreaterThan(0);
    expect(sentLine?.insight.summary.length).toBeGreaterThan(0);
    expect(sentLine?.actions).toEqual(["evidence", "read", "snooze", "dismiss"]);
    const low = feed.lines.find((l) => l.status === "digest");
    expect(low).toMatchObject({ reason: "low-confidence", readAt: null });
    expect(low?.insight.summary).toBe("낮은 신뢰 요약");
    expect(feed.unread).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "insight", count: 1, unread: 1 });
  });

  it("drops a line when its source is deleted afterwards: the list and the count answer at once", async () => {
    const { call, runPeriod, importIn } = await backend();
    await importIn(IMPORT);
    db.run("UPDATE insights SET urgency_date = ?, confidence = 100 WHERE state = 'active'", [
      new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10),
    ]);
    await runPeriod("scan");
    expect((await call("notifications")).body.lines).toHaveLength(1);
    const before = (await call("changes")).body;
    expect(before.unread).toBe(1);

    const wiki = JSON.parse(read("v02-wiki.jsonl")) as Record<string, unknown>;
    await productImporter(db, { runner: runner as JobRunner })(
      jsonl({ ...wiki, operation: "delete", content: "", version: 2 }),
    );

    expect((await call("notifications")).body).toMatchObject({ lines: [], digests: [], unread: 0 });
    const after = (await call("changes")).body;
    expect(after.unread).toBe(0);
    expect(after.sources).toBeGreaterThan(before.sources);
    expect(after.notifications).toBeGreaterThanOrEqual(before.notifications);
  });
});

describe("notify.flow: the digest's and the report's content, computed when read (P02-C1b read)", () => {
  it("lists the window's lines with their reasons and, for the weekly report, the rule counts", async () => {
    const { call } = await backend();
    seedInsight(db, { name: "중요" });
    seedInsight(db, { name: "낮음", confidence: 30 });
    notifyNow(db, "scan");
    notifyNow(db, "daily", "2026-11-24T09:00:00.000Z");
    notifyNow(db, "weekly", "2026-11-30T09:10:00.000Z");

    const feed = (await call("notifications")).body;
    const [daily, weekly] = ["daily", "weekly"].map((k) => feed.digests.find((d) => d.kind === k));
    expect(daily).toBeDefined();
    expect(weekly).toBeDefined();

    const day = (await call("notificationDigest", { id: daily?.id as number })).body;
    expect(day.status).toBe("ok");
    if (day.status !== "ok") return;
    expect(day.lines.map((l) => [l.insight.summary, l.reason]).sort()).toEqual([
      ["낮음 요약", "low-confidence"],
      ["중요 요약", null],
    ]);
    expect(day.lint).toBeNull();

    const week = (await call("notificationDigest", { id: weekly?.id as number })).body;
    if (week.status !== "ok") throw new Error("weekly digest");
    expect(week.lint?.counts.map((c) => c.rule)).toEqual([
      "synonym",
      "stale",
      "overdue-work",
      "missing-link",
    ]);
    expect((await call("notificationDigest", { id: 999_999 })).body).toEqual({
      status: "not-found",
    });
  });

  it("leaves a digest row out while its window holds only lines the user hid (reviewer FU4)", async () => {
    const { call } = await backend();
    const [a, b] = [seedInsight(db, { name: "하나" }), seedInsight(db, { name: "둘" })];
    notifyNow(db, "scan");
    notifyNow(db, "daily", "2026-11-24T09:00:00.000Z");
    expect((await call("notifications")).body.digests).toHaveLength(1);

    for (const { insightId } of [a, b]) {
      const done = await call("feedbackRecord", {
        target: { kind: "insight", id: insightId },
        kind: "irrelevant",
      });
      expect(done.status).toBe(200);
    }

    expect((await call("notifications")).body).toMatchObject({ lines: [], digests: [], unread: 0 });
  });
});

describe("notify.flow: the user's actions (P02-R11, C3c ②)", () => {
  it("reads, snoozes, takes back and dismisses a line; the timeline keeps it and the shell's waiting message is cancelled", async () => {
    const { call } = await backend();
    seedInsight(db, { name: "알림" });
    notifyNow(db, "scan");
    const line = () => listNotifications(db).find((n) => n.kind === "insight");
    const id = line()?.id as number;
    const act = async (request: RouteRequest<"notificationAct">) =>
      (await call("notificationAct", request)).body;

    expect(await act({ id, op: "read" })).toMatchObject({ status: "applied", unread: 0 });
    expect(line()?.readAt).not.toBeNull();

    expect(await act({ id, op: "snooze", minutes: 60 })).toMatchObject({ status: "applied" });
    expect(line()).toMatchObject({ status: "deferred", notBefore: "2026-11-23T10:00:00.000Z" });
    const deferred = (await call("notifications")).body.lines[0];
    expect(deferred).toMatchObject({ status: "deferred", notBefore: "2026-11-23T10:00:00.000Z" });
    expect(deferred?.actions).toEqual(["evidence", "unsnooze", "dismiss"]);

    expect(await act({ id, op: "unsnooze" })).toMatchObject({ status: "applied" });
    expect(line()).toMatchObject({ status: "sent", notBefore: null, osState: "cancelled" });

    expect(await act({ id, op: "dismiss" })).toMatchObject({ status: "applied" });
    const closed = (await call("notifications")).body.lines[0];
    expect(closed).toMatchObject({ status: "dismissed", actions: ["evidence"] });
    expect(await act({ id: 999_999, op: "read" })).toMatchObject({ status: "not-found" });
  });

  it("answers 400 to an op outside the four and to a snooze time outside the three values", async () => {
    const { call } = await backend();
    seedInsight(db, { name: "알림" });
    notifyNow(db, "scan");
    const id = listNotifications(db)[0]?.id as number;
    const bad = [
      { id, op: "email" },
      { id, op: "snooze", minutes: 61 },
      { id, op: "snooze" },
    ];
    for (const body of bad) {
      expect((await call("notificationAct", body as never)).status).toBe(400);
    }
    expect(listNotifications(db)[0]?.status).toBe("sent");
  });
});

describe("notify.flow: the settings and the change numbers (P02-R14, R16)", () => {
  it("reads the defaults, writes the three settings the outbox reads, and the notification number moves with a change", async () => {
    const { call } = await backend();
    expect((await call("notificationSettings")).body).toEqual({
      os: true,
      quietHours: { enabled: true, start: "22:00", end: "08:00" },
      snoozeUntil: null,
    });
    const set = await call("setNotificationSettings", {
      os: false,
      quietHours: { enabled: true, start: "23:00", end: "07:30" },
      snoozeUntil: "2026-11-24T00:00:00.000Z",
    });
    expect(set.status).toBe(200);
    expect(readNotifySettings(db)).toEqual({
      os: false,
      quietHours: { enabled: true, start: "23:00", end: "07:30" },
      snoozeUntil: "2026-11-24T00:00:00.000Z",
    });
    expect((await call("setNotificationSettings", { snoozeUntil: null })).body).toMatchObject({
      snoozeUntil: null,
      os: false,
    });
    expect(
      (
        await call("setNotificationSettings", {
          quietHours: { enabled: true, start: "25:00", end: "07:30" },
        })
      ).status,
    ).toBe(400);

    const before = (await call("changes")).body;
    seedInsight(db, { name: "새" });
    notifyNow(db, "scan");
    const after = (await call("changes")).body;
    expect(after.notifications).toBeGreaterThan(before.notifications);
    expect(after.unread).toBe(1);
  });
});
