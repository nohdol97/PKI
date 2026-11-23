// S03-T09 (S03-C1; R4, R6, R8): a CSV from an approved folder, through the real local-files connector and
// normalizer, becomes a Dataset and a table; a Markdown beside it states the grain and the calculation, and
// the check runs against that table; deleting the file takes the table away and disputes the approved
// calculation. Synthetic data only; the folder is a real temporary one, the Provider is a double.
import { routes, type AnalyticalList } from "@pki/contracts";
import { FakeProvider, send } from "@pki/testkit";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { inProcessNormalizer } from "./local-normalizer.test-support.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "e".repeat(43);
let root: string;
let docs: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-analytical-e2e-")));
  docs = join(root, "docs");
  mkdirSync(docs);
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(root, { recursive: true, force: true });
});

const GRAIN_QUOTE = "Each row of orders is one order identified by order_id";
const CALC_QUOTE = "Order total is the sum of amount over orders";
const MARKDOWN = `${GRAIN_QUOTE}.\n\n${CALC_QUOTE}.\n`;

function write(name: string, text: string) {
  writeFileSync(join(docs, name), text);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(docs, name), old, old);
}

it("analytical.e2e-import: a CSV from an approved folder becomes a Dataset, the Markdown's grain and calculation check against it, and deleting the file takes the table away and disputes the approved calculation", async () => {
  const provider = new FakeProvider({
    id: "local-model",
    transport: "http",
    answer: (request) => {
      const doc = request.input.untrustedDocuments[0]?.body ?? "";
      const out = {
        items: [],
        facts: [],
        relations: [],
        terms: [],
        definitions: [],
        proposedTypes: [],
      };
      if (!doc.includes(GRAIN_QUOTE)) return out;
      const existing = request.input.candidates.find((c) => c.name === "orders")?.id ?? null;
      return {
        ...out,
        items: [
          { ref: "M", type: "Metric", name: "Order total", existingItemId: null },
          { ref: "D", type: "Dataset", name: "orders", existingItemId: existing },
        ],
        facts: [
          {
            item: "D",
            kind: "dataset.grain",
            value: '["order_id"]',
            epistemic: "explicit",
            quote: GRAIN_QUOTE,
          },
          {
            item: "M",
            kind: "metric.calculation",
            value: '{"aggregation":"sum","column":"amount"}',
            epistemic: "explicit",
            quote: CALC_QUOTE,
          },
        ],
        relations: [{ subject: "M", type: "MEASURED_ON", object: "D", quote: CALC_QUOTE }],
      };
    },
  });
  booted = await bootBackend({
    dataDir: join(root, "data"),
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [provider],
    localFiles: { normalizer: inProcessNormalizer() },
  });
  const { db, server } = booted;
  const headers = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
  const call = (path: string, method = "GET", body?: unknown) =>
    send(server.port, path, headers, method, body);
  const sync = async () => {
    // a new file is imported by the second sync that sees it (settle rule), so complete two syncs; each
    // one retries `instance-busy`, the lock held by the job the approval or the watcher registered
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await vi.waitFor(
        async () => {
          const synced = await call(routes.syncConnector.path, "POST", {
            connectorId: "local-files",
          });
          expect(synced.status).toBe(200);
          expect((synced.body as { stopped?: string }).stopped).not.toBe("instance-busy");
        },
        { timeout: 20_000, interval: 50 },
      );
    }
  };
  const analytical = async () => (await call(routes.analytical.path)).body as AnalyticalList;

  // the Provider may see "general" content, and the analytical profile is switched ON (it ships OFF)
  await call(routes.setDefaultProvider.path, "POST", { providerId: "local-model" });
  const consents = await call(routes.consents.path);
  const shown = consents.body as {
    providers: { providerId: string; destination: string }[];
    policyVersion: string;
  };
  await call(routes.grantConsent.path, "POST", {
    providerId: "local-model",
    allowedClasses: ["general"],
    destination: shown.providers.find((p) => p.providerId === "local-model")?.destination ?? "",
    policyVersion: shown.policyVersion,
  });
  await call(routes.setLocalFilesSettings.path, "POST", { settleMs: 1 });
  await call(routes.setAnalyticalSettings.path, "POST", { profile: true, maxCells: 200_000 });

  // 1. the CSV: one table, a Dataset named by the file, two column facts, a check job (R4, R6)
  write("orders.csv", "order_id,amount\n1,10\n2,20");
  expect(
    (await call(routes.approveLocalLocation.path, "POST", { type: "folder", path: docs })).status,
  ).toBe(200);
  await sync();
  await vi.waitFor(
    () => {
      expect(db.all("SELECT 1 FROM dataset_tables")).toHaveLength(1);
      expect(db.all("SELECT 1 FROM items WHERE type = 'Dataset' AND name = 'orders'")).toHaveLength(
        1,
      );
      expect(db.all("SELECT 1 FROM facts WHERE kind = 'dataset.column'")).toHaveLength(2);
      expect(db.all("SELECT status FROM jobs WHERE kind = 'analytical-check'")).toEqual([
        { status: "succeeded" },
      ]);
    },
    { timeout: 20_000 },
  );

  // 2. the Markdown names the same Dataset; its grain and calculation are extracted onto it
  write("kpi.md", MARKDOWN);
  await sync();
  await vi.waitFor(
    () => {
      expect(db.all("SELECT 1 FROM facts WHERE kind = 'metric.calculation'")).toHaveLength(1);
      expect(db.all("SELECT 1 FROM items WHERE type = 'Dataset'")).toHaveLength(1);
    },
    { timeout: 20_000 },
  );

  // 3. extraction queues no check: ask for it (R8); the grain and the column are checked against the table
  const metric = db.all("SELECT id FROM items WHERE type = 'Metric'")[0]?.id as number;
  const asked = await call(routes.analyticalCheck.path, "POST", { itemId: metric });
  expect(asked.status).toBe(200);
  await vi.waitFor(
    async () => {
      const m = (await analytical()).metrics[0];
      expect(m?.columns).toEqual([{ column: "amount", factId: expect.any(Number), missing: null }]);
      expect(m?.calculations[0]?.checks.every((c) => c.passed)).toBe(true);
      expect(m?.calculations[0]?.checks.length).toBeGreaterThan(0);
      const grain = (await analytical()).datasets[0]?.grain[0];
      expect(grain?.checks.length).toBeGreaterThan(0);
      expect(grain?.checks.every((c) => c.passed)).toBe(true);
    },
    { timeout: 20_000 },
  );

  // 4. the user approves what the gate names until the calculation is verified
  const calc = (await analytical()).metrics[0]?.calculations[0];
  const factId = calc?.id as number;
  for (let i = 0; i < 6; i++) {
    const outcome = (
      await call(routes.semanticDecide.path, "POST", {
        kind: "fact",
        id: factId,
        action: "approve",
      })
    ).body as { status: string; unmet?: string[] };
    if (outcome.status === "applied" || outcome.status === "unchanged") break;
    const grain = (await analytical()).datasets[0]?.grain[0]?.id as number;
    const grainOutcome = (
      await call(routes.semanticDecide.path, "POST", { kind: "fact", id: grain, action: "approve" })
    ).body as { status: string };
    expect(["applied", "unchanged"]).toContain(grainOutcome.status);
  }
  expect((await analytical()).metrics[0]?.calculations[0]?.status).toBe("verified");

  // 5. the file is deleted: the table, its column facts and the check lines go; the calculation is disputed
  unlinkSync(join(docs, "orders.csv"));
  await sync();
  await vi.waitFor(
    async () => {
      expect(db.all("SELECT 1 FROM dataset_tables")).toEqual([]);
      expect(db.all("SELECT 1 FROM facts WHERE kind = 'dataset.column'")).toEqual([]);
      const list = await analytical();
      expect(list.datasets).toHaveLength(1);
      expect(list.datasets[0]?.tables).toEqual([]);
      expect(list.metrics[0]?.calculations[0]?.status).toBe("disputed");
      expect(list.metrics[0]?.calculations[0]?.checks).toEqual([]);
      expect(list.datasets[0]?.grain[0]?.checks).toEqual([]);
    },
    { timeout: 20_000 },
  );
}, 30_000);
