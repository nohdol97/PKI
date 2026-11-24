// NGT-C3 (R3): a booted backend with a shell channel. An import's extraction closes, the scan wakes and writes the
// line of an important Insight as `sent`, and the closed `notify` job hands one message to the channel. Synthetic
// data only; the Provider and the channel are doubles. The Insight's date is wall-clock based because the outbox
// takes no boot clock (NGT-D2).
import { routes } from "@pki/contracts";
import { DEFAULT_PROVIDER_SETTING } from "@pki/providers";
import { listNotifications, registerConnectorInstance, writeSetting } from "@pki/storage";
import { FakeProvider, fixtureExtraction, send } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { fakeChannel, seedInsight } from "./notify.test-support.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "b".repeat(43);
const FIXTURE = readFileSync(resolve(import.meta.dirname, "../../fixtures/v02-wiki.jsonl"), "utf8");
const DAY = 86_400_000;

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-notify-booted-"));
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(dir, { recursive: true, force: true });
});

it("notify.booted: an import's closed extraction wakes the scan, and the closed notify job sends one message to the shell channel (NGT-C3)", async () => {
  const { channel, sent } = fakeChannel();
  booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [
      new FakeProvider({ id: "local-model", transport: "http", answer: fixtureExtraction() }),
    ],
    notifyChannel: channel,
  });
  const { db, server } = booted;
  const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  const post = (path: string, body: unknown) => send(server.port, path, headers, "POST", body);

  writeSetting(db, DEFAULT_PROVIDER_SETTING, "local-model");
  const consents = (await send(server.port, routes.consents.path, headers, "GET")).body as {
    providers: { providerId: string; destination: string }[];
    policyVersion: string;
  };
  await post(routes.grantConsent.path, {
    providerId: "local-model",
    allowedClasses: ["general"],
    destination: consents.providers.find((p) => p.providerId === "local-model")?.destination ?? "",
    policyVersion: consents.policyVersion,
  });
  // the outbox reads the wall clock: no quiet hours, so the line goes out whenever the test runs
  await post(routes.setNotificationSettings.path, {
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
  });

  registerConnectorInstance(db, "c1", "test-fixtures");
  const soon = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  const { insightId } = seedInsight(db, { name: "부팅", urgencyDate: soon });

  expect((await post(routes.importJsonl.path, { text: FIXTURE.trim() })).status).toBe(200);
  await vi.waitFor(
    async () => {
      await booted?.runner.wake();
      expect(sent.filter((m) => m.kind === "insight")).toHaveLength(1);
    },
    { timeout: 20_000, interval: 50 },
  );

  const line = listNotifications(db).find((n) => n.insightId === insightId);
  expect(line?.status).toBe("sent");
}, 30_000);
