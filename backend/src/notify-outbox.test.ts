// P02-C2c (R6, R10, R11) and P02-C3a ② (R8): the OS channel is one count-only message per flush, held in quiet
// hours and by a snooze and sent once afterwards; the feed lines stay whatever the shell answers or lacks; a
// deferred line comes back after its time; `handed` is written before the message goes, so a cut send is never
// repeated while a line still `queued` goes once.
import {
  listNotifications,
  deferNotification,
  migrate,
  registerConnectorInstance,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { createProductRegistry } from "@pki/knowledge-engine";
import { defaultScopePolicy } from "@pki/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeChannel, notifyNow, seedInsight } from "./notify.test-support.ts";
import { createNotifyOutbox } from "./notify-outbox.ts";

const registry = createProductRegistry({ policy: defaultScopePolicy });
let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const outboxAt = (channel: ReturnType<typeof fakeChannel>["channel"] | null, now: () => string) =>
  createNotifyOutbox({ db, registry, channel, now: () => new Date(now()), zone: () => "UTC" });
const states = () => listNotifications(db).map((n) => `${n.status}/${n.osState}`);

describe("notify.outbox: quiet hours hold the OS channel, never the feed (P02-C2c ①)", () => {
  it("sends no message in quiet hours while both lines stay sent, then one message of count 2 with nothing but counts", () => {
    seedInsight(db, { name: "하나" });
    seedInsight(db, { name: "둘" });
    notifyNow(db, "scan", "2026-11-23T22:30:00.000Z");
    const { channel, sent } = fakeChannel();
    let now = "2026-11-23T23:00:00.000Z";
    const outbox = outboxAt(channel, () => now);

    outbox.flush();
    expect(sent).toEqual([]);
    expect(states()).toEqual(["sent/queued", "sent/queued"]);

    now = "2026-11-24T08:30:00.000Z";
    outbox.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "notify", kind: "insight", count: 2, unread: 2 });
    expect(Object.keys(sent[0] as object).sort()).toEqual([
      "count",
      "id",
      "kind",
      "type",
      "unread",
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/하나|둘/);
    expect(states()).toEqual(["sent/handed", "sent/handed"]);
  });

  it("a snooze holds the channel until its time, and the OS setting off ends the lines as unavailable", () => {
    seedInsight(db, { name: "하나" });
    notifyNow(db, "scan", "2026-11-23T12:00:00.000Z");
    writeSetting(db, "notifications.snoozeUntil", "2026-11-23T15:00:00.000Z");
    const { channel, sent } = fakeChannel();
    let now = "2026-11-23T13:00:00.000Z";
    const outbox = outboxAt(channel, () => now);

    outbox.flush();
    expect(sent).toEqual([]);
    now = "2026-11-23T15:01:00.000Z";
    writeSetting(db, "notifications.os", "off");
    outbox.flush();
    expect(sent).toEqual([]);
    expect(states()).toEqual(["sent/unavailable"]);
  });
});

describe("notify.outbox: the feed lines stay whatever the shell says (P02-C2c ②)", () => {
  it("a shell that answers unavailable, and no shell at all, leave the line sent", () => {
    seedInsight(db, { name: "하나" });
    notifyNow(db, "scan", "2026-11-23T12:00:00.000Z");
    const { channel, sent } = fakeChannel();
    const outbox = outboxAt(channel, () => "2026-11-23T12:30:00.000Z");
    outbox.flush();
    const id = (sent[0] as { id: string }).id;
    expect(outbox.acknowledge({ type: "notify-ack", id, result: "unavailable" })).toBe(true);
    expect(states()).toEqual(["sent/unavailable"]);

    const other = openBetterSqlite3(":memory:");
    migrate(other);
    registerConnectorInstance(other, "c1", "test-fixtures");
    seedInsight(other, { name: "둘" });
    notifyNow(other, "scan", "2026-11-23T12:00:00.000Z");
    const none = createNotifyOutbox({
      db: other,
      registry,
      channel: null,
      now: () => new Date("2026-11-23T12:30:00.000Z"),
      zone: () => "UTC",
    });
    none.flush();
    expect(listNotifications(other).map((n) => `${n.status}/${n.osState}`)).toEqual([
      "sent/unavailable",
    ]);
    other.close();
  });
});

describe("notify.outbox: a deferred line comes back after its time and takes the OS channel again (P02-C2c ③)", () => {
  it("is not sent before the time, is sent after it, and a message follows", () => {
    seedInsight(db, { name: "하나" });
    notifyNow(db, "scan", "2026-11-23T12:00:00.000Z");
    const [line] = listNotifications(db);
    deferNotification(db, line?.id as number, "2026-11-23T16:00:00.000Z");
    expect(states()).toEqual(["deferred/cancelled"]);

    notifyNow(db, "scan", "2026-11-23T15:00:00.000Z");
    expect(states()).toEqual(["deferred/cancelled"]);

    notifyNow(db, "scan", "2026-11-23T16:30:00.000Z");
    expect(states()).toEqual(["sent/queued"]);
    const { channel, sent } = fakeChannel();
    outboxAt(channel, () => "2026-11-23T16:31:00.000Z").flush();
    expect(sent).toHaveLength(1);
  });
});

describe("notify.outbox: at most once (P02-C3a ②)", () => {
  it("writes handed before the message goes, so a send cut there is never repeated by a new process", () => {
    seedInsight(db, { name: "하나" });
    notifyNow(db, "scan", "2026-11-23T12:00:00.000Z");
    const at = () => "2026-11-23T12:30:00.000Z";
    let seen: string[] = [];
    const cut = fakeChannel(() => {
      seen = states();
      throw new Error("the process died before the message went");
    });
    outboxAt(cut.channel, at).flush();
    expect(seen).toEqual(["sent/handed"]);

    const fresh = fakeChannel();
    outboxAt(fresh.channel, at).flush();
    expect(fresh.sent).toEqual([]);
  });

  it("a line still queued when the process was cut is sent once", () => {
    seedInsight(db, { name: "하나" });
    notifyNow(db, "scan", "2026-11-23T12:00:00.000Z");
    const { channel, sent } = fakeChannel();
    const outbox = outboxAt(channel, () => "2026-11-23T12:30:00.000Z");
    outbox.flush();
    outbox.flush();
    expect(sent).toHaveLength(1);
  });
});
