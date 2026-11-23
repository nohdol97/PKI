// K02-C1b (R2, R11, R15), K02-C3a ② ③ (R2, R3): a synthetic JSONL goes in through the import, the extraction runs,
// and the daily period's "run now" re-reviews: the API lists a `missing-link` finding with its evidence, accepting
// it with a relation type writes the user's relation and marks the finding accepted, and an entry that refuses the
// type leaves it open. The started backend has the two periods; a daily run looks only at the marked bundles, a
// weekly one adds the bundles of open findings and still not the whole knowledge.
import { createHash } from "node:crypto";
import {
  routes,
  type RouteName,
  type RouteRequest,
  type RouteResponse,
  type StructuredRequest,
} from "@pki/contracts";
import { DEFAULT_PROVIDER_SETTING, type EgressControls } from "@pki/providers";
import { saveRelation, userDecisions, writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider, send } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
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
import { ensureReflectionSchedules } from "./reflection-schedules.ts";
import { createScheduler } from "./scheduler.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { startServer, type RunningServer } from "./server.ts";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");
const TOKEN = "l".repeat(43);
const connectors: ConnectorManager = { list: () => [], sync: async () => ({ error: "not-found" }) };
const SKY = "하늘 프로젝트의 완료 목표는 2026-12-05입니다";
const WIND = "바람 시스템 개발 완료는 2026-12-10입니다";

let dir: string;
let db: SqlDriver;
let server: RunningServer | undefined;
let runner: JobRunner | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-lint-flow-"));
  db = openCanonicalDb(dir);
});
afterEach(async () => {
  await server?.close();
  await runner?.stop();
  server = undefined;
  runner = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Records on the mail fixture's shape: two that name the same two items, and `extra` that name one each. */
function jsonl(extra: number): string {
  const mail = JSON.parse(
    readFileSync(resolve(FIXTURES, "v02-mail.jsonl"), "utf8").trim(),
  ) as object;
  const record = (id: string, content: string) =>
    JSON.stringify({
      ...mail,
      id,
      connector_instance_id: "conn-lint",
      external_id: id,
      title: id,
      content,
      content_hash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    });
  return [
    record("lint-0001", `합성 자료입니다. ${SKY}. ${WIND}.`),
    record("lint-0002", `합성 회의록입니다. ${SKY}. ${WIND}.`),
    ...Array.from({ length: extra }, (_, i) =>
      record(
        `lint-x${i}`,
        `합성 자료입니다. 별도 프로젝트 ${i}의 완료 목표는 2026-12-0${(i % 9) + 1}입니다.`,
      ),
    ),
  ].join("\n");
}

function consent(egress: EgressControls) {
  const shown = egress.overview().providers.find((p) => p.providerId === "local-model");
  const granted = egress.grant("local-model", ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/** The extraction double: it answers what the synthetic records say, nothing else. */
function answer(request: StructuredRequest) {
  const body = request.input.untrustedDocuments[0]?.body ?? "";
  const known = (name: string) => request.input.candidates.find((c) => c.name === name)?.id ?? null;
  const out = {
    items: [] as object[],
    facts: [] as object[],
    relations: [],
    terms: [],
    definitions: [],
  };
  const add = (
    ref: string,
    type: string,
    name: string,
    kind: string,
    quote: string,
    value: string,
  ) => {
    out.items.push({ ref, type, name, existingItemId: known(name) });
    out.facts.push({ item: ref, kind, value, epistemic: "explicit", quote });
  };
  if (body.includes(SKY)) {
    add("p", "Project", "하늘 프로젝트", "target_date", SKY, "2026-12-05");
    add("s", "System", "바람 시스템", "completion_date", WIND, "2026-12-10");
  }
  const extra = /별도 프로젝트 (\d+)의 완료 목표는 (2026-12-0\d)입니다/.exec(body);
  if (extra) {
    add(
      "x",
      "Project",
      `별도 프로젝트 ${extra[1]}`,
      "target_date",
      `별도 프로젝트 ${extra[1]}의 완료 목표는 ${extra[2]}입니다`,
      extra[2] as string,
    );
  }
  return out;
}

async function backend() {
  const egress = productEgress(db);
  const provider = new FakeProvider({ id: "local-model", transport: "http", answer });
  writeSetting(db, DEFAULT_PROVIDER_SETTING, provider.id);
  const calls = productCalls(db, egress, { providers: [provider] });
  const run = productRunner(db, calls.broker, { policyFingerprint: calls.policyFingerprint });
  runner = run;
  consent(egress);
  const scheduler = createScheduler({ db, onRegistered: () => void run.wake() });
  ensureReflectionSchedules(scheduler);
  server = await startServer({
    token: TOKEN,
    allowedOrigins: [],
    connectors,
    db,
    dataDirectory: dir,
    egress,
    decisions: userDecisions,
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
  /** The period's "run now", then the runner takes the job. */
  const reflect = async (target: "daily" | "weekly") => {
    const schedule = scheduler.list().find((s) => s.kind === "reflect" && s.target === target);
    scheduler.runNow(schedule?.id as number);
    await run.wake();
  };
  return {
    call,
    reflect,
    importIn: async (text: string) => (await importer(text), await run.wake()),
  };
}

const itemId = (name: string) =>
  db.all("SELECT id FROM items WHERE name = ?", [name])[0]?.id as number;

describe("lint.flow: from an import to a finding the user accepts (K02-C1b)", () => {
  it("lists the missing link with evidence; accepting with a type writes the user's relation, and a refusing entry leaves it open", async () => {
    const { call, reflect, importIn } = await backend();
    await importIn(jsonl(0));
    const [sky, wind] = [itemId("하늘 프로젝트"), itemId("바람 시스템")] as [number, number];
    // a relation of that type that was rejected: the pair is still unrelated, and the entry will refuse the same triple
    saveRelation(db, {
      subjectId: sky,
      type: "DEPENDS_ON",
      objectId: wind,
      epistemic: "explicit",
      status: "rejected",
      validAt: null,
      observedAt: "2026-11-21T00:00:00Z",
    });

    await reflect("daily");

    const listed = (await call("lint")).body;
    const finding = listed.findings.find((f) => f.rule === "missing-link");
    expect(finding?.status).toBe("open");
    expect(finding?.targets.map((t) => t.label).sort()).toEqual(["바람 시스템", "하늘 프로젝트"]);
    expect(finding?.evidence.length).toBeGreaterThan(0);
    const opened = await call("evidenceSource", { evidenceId: finding?.evidence[0] as number });
    expect(opened.status).toBe(200);

    const id = finding?.id as number;
    const refused = (await call("lintDecide", { id, op: "accept", relationType: "DEPENDS_ON" }))
      .body;
    expect(refused).toMatchObject({ status: "refused", reason: "value-exists" });
    expect((await call("lint")).body.findings.find((f) => f.id === id)?.status).toBe("open");

    const accepted = (await call("lintDecide", { id, op: "accept", relationType: "RELATED_TO" }))
      .body;
    expect(accepted.status).toBe("applied");
    expect(accepted.finding?.status).toBe("accepted");
    expect(
      db.all(
        "SELECT user_authored, status FROM relations WHERE subject_id = ? AND type = 'RELATED_TO' AND object_id = ?",
        [sky, wind],
      ),
    ).toEqual([{ user_authored: 1, status: "verified" }]);
  });
});

describe("lint.flow: the periods and the range of a run (K02-C3a ② ③)", () => {
  it("② a started backend has the daily and the weekly period of `reflect`", async () => {
    db.close(); // the booted backend opens the data directory itself
    const booted = await bootBackend({
      dataDir: dir,
      token: TOKEN,
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
    });
    try {
      expect(
        booted.scheduler
          .list()
          .filter((s) => s.kind === "reflect")
          .map((s) => [s.target, s.period.kind]),
      ).toEqual([
        ["daily", "daily"],
        ["weekly", "weekly"],
      ]);
    } finally {
      await booted.server.close();
      booted.db.close();
      db = openCanonicalDb(dir); // afterEach closes one handle
    }
  });

  it("③ daily sees the marked bundles only; weekly adds the open findings' bundles and still not every bundle", async () => {
    const { call, reflect, importIn } = await backend();
    await importIn(jsonl(10));
    const total = db.all("SELECT count(*) AS n FROM items")[0]?.n as number;
    expect(total).toBe(12);

    await reflect("daily"); // everything was marked by the import
    expect((await call("lint")).body.lastRun?.counts).toMatchObject({
      bundles: total,
      dirtyLeft: 0,
    });

    db.run("UPDATE facts SET valid_until = '2027-01-01' WHERE item_id = ?", [
      itemId("별도 프로젝트 3"),
    ]);
    await reflect("daily");
    expect((await call("lint")).body.lastRun?.counts).toMatchObject({ bundles: 1, dirtyLeft: 0 });

    await reflect("weekly"); // the missing link's two items
    const weekly = (await call("lint")).body.lastRun?.counts;
    expect(weekly?.bundles).toBe(2);
    expect(weekly?.bundles).toBeLessThan(total);
  });
});
