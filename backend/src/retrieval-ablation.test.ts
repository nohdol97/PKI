// X01-T4 (X01-C3): the retrieval ablation runner. ① On a two-question dev sample it writes the five configurations'
// predictions lines and `eval/scorer/score.py` scores them; the sealed eval split is refused. ② The result file
// and the ADR of the strategy decision exist, the ADR carries the file's numbers, and the code constant of the
// default strategies is the ADR's list. The vector here is a fake embedder: it proves the plumbing only, and no
// figure from it is a measurement.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_ENABLED_STRATEGIES } from "@pki/knowledge-engine";
import { FakeEmbedder, MemoryVectorIndex } from "@pki/testkit";
import { describe, expect, it, vi } from "vitest";
import { runAblation } from "./retrieval-ablation.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const GOLDEN = resolve(ROOT, "eval/golden");
const SCORER = resolve(ROOT, "eval/scorer/score.py");
const RESULT = resolve(ROOT, "eval/results/x01-dev-t0.json");
const MAIN = resolve(import.meta.dirname, "retrieval-ablation.main.test-support.ts");
const ADR = resolve(ROOT, "docs/adr/0025-retrieval-strategies.md");

const jsonl = (file: string) =>
  readFileSync(resolve(GOLDEN, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const devInstances = new Set(
  (
    JSON.parse(readFileSync(resolve(GOLDEN, "splits.json"), "utf8")) as {
      splits: { dev: string[] };
    }
  ).splits.dev,
);
const sample = jsonl("labels/qa.jsonl")
  .filter((q) => q.answerable === true && devInstances.has(q.scenario_instance as string))
  .slice(0, 2)
  .map((q) => q.label_id as string);

async function readyVector() {
  const embedding = new FakeEmbedder();
  await embedding.prepare({ kind: "local-pack", path: "/fake" }, new AbortController().signal);
  return { embedding, index: new MemoryVectorIndex() };
}

describe("X01-C3 ① the ablation runner", () => {
  vi.setConfig({ testTimeout: 120_000 });

  it("writes the five configurations' predictions lines for a two-question dev sample and score.py scores them", async () => {
    const run = await runAblation({
      goldenDir: GOLDEN,
      split: "dev",
      questionIds: sample,
      vector: await readyVector(),
    });
    expect(sample).toHaveLength(2);
    expect(run.corpus).toMatchObject({ tier: "T0", lines: 155, errors: 0 });
    expect(run.seeded.relations).toBeGreaterThan(0);
    expect(run.seeded.facts).toBeGreaterThan(0);
    expect(run.configs.map((c) => c.id)).toEqual(["C1", "C2", "C3", "C4", "C5"]);

    const dir = mkdtempSync(join(tmpdir(), "pki-ablation-"));
    try {
      for (const config of run.configs) {
        if (config.status !== "measured") throw new Error(`${config.id} was not measured`);
        expect(config.lines).toHaveLength(2);
        const rows = config.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(rows.map((r) => r.query_id).sort()).toEqual([...sample].sort());
        for (const row of rows) {
          expect(row.kind).toBe("retrieval");
          expect(Array.isArray(row.ranked)).toBe(true);
        }
        const file = join(dir, `${config.id}.jsonl`);
        writeFileSync(file, `${config.lines.join("\n")}\n`);
        const scored = spawnSync("python3", ["-I", SCORER, GOLDEN, file, "--split", "dev"], {
          encoding: "utf8",
        });
        expect(scored.status, scored.stderr).toBe(0);
        const retrieval = (JSON.parse(scored.stdout) as { retrieval: Record<string, number> })
          .retrieval;
        expect(retrieval.missing_predictions).toBe((retrieval.n_queries as number) - 2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fake a vector: no model or a model not ready is `not-measured` with the reason, and the other four are measured; eval is refused", async () => {
    const none = await runAblation({
      goldenDir: GOLDEN,
      split: "dev",
      questionIds: sample,
      vectorNotMeasured: "no local model pack on this machine",
    });
    expect(none.configs.map((c) => c.status)).toEqual([
      "measured",
      "not-measured",
      "measured",
      "measured",
      "measured",
    ]);
    expect(none.configs[1]).toMatchObject({ reason: "no local model pack on this machine" });

    const notReady = await runAblation({
      goldenDir: GOLDEN,
      split: "dev",
      questionIds: sample,
      vector: { embedding: new FakeEmbedder(), index: new MemoryVectorIndex() },
    });
    expect(notReady.configs[1]).toMatchObject({
      status: "not-measured",
      reason: expect.stringContaining("model-missing"),
    });

    await expect(
      runAblation({ goldenDir: GOLDEN, split: "eval" as never, questionIds: sample }),
    ).rejects.toThrow(/sealed/);
  });
});

describe("X01-C3 ① the measuring command", () => {
  it("writes a result file and a predictions file per configuration; `--without-vector` leaves C2 out on purpose", () => {
    const out = mkdtempSync(join(tmpdir(), "pki-ablation-main-"));
    try {
      const ran = spawnSync(
        process.execPath,
        [MAIN, "--out", out, "--name", "smoke", "--without-vector"],
        { encoding: "utf8", cwd: ROOT, timeout: 170_000 },
      );
      expect(ran.status, ran.stderr).toBe(0);
      const result = JSON.parse(readFileSync(join(out, "smoke.json"), "utf8")) as {
        configs: { status: string; reason?: string; retrieval?: { n_queries: number } }[];
      };
      expect(result.configs.map((c) => c.status)).toEqual([
        "measured",
        "not-measured",
        "measured",
        "measured",
        "measured",
      ]);
      expect(result.configs[1]?.reason).toContain("left out on purpose");
      expect(result.configs[0]?.retrieval?.n_queries).toBe(23);
      expect(existsSync(join(out, "smoke-predictions", "C5.jsonl"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("X01-C3 ② the result file, the ADR and the default list agree", () => {
  it("the dev/T0 result file is there, the ADR carries its numbers, and DEFAULT_ENABLED_STRATEGIES is the ADR's list", () => {
    expect(existsSync(RESULT)).toBe(true);
    expect(existsSync(ADR)).toBe(true);
    const result = JSON.parse(readFileSync(RESULT, "utf8")) as {
      split: string;
      corpus: { tier: string };
      configs: {
        id: string;
        status: string;
        reason?: string;
        retrieval?: { recall_at_k: number; precision_at_k: number; mrr: number };
      }[];
    };
    expect(result.split).toBe("dev");
    expect(result.corpus.tier).toBe("T0");
    expect(result.configs.map((c) => c.id)).toEqual(["C1", "C2", "C3", "C4", "C5"]);

    const adr = readFileSync(ADR, "utf8");
    for (const config of result.configs) {
      if (config.status === "measured") {
        const r = config.retrieval as NonNullable<typeof config.retrieval>;
        for (const value of [r.recall_at_k, r.precision_at_k, r.mrr]) {
          expect(adr, `${config.id} ${value}`).toContain(value.toFixed(3));
        }
      } else {
        expect(config.status).toBe("not-measured");
        expect(config.reason).toBeTruthy();
        expect(adr).toContain(`${config.id}`);
      }
    }

    const listed = /^- \*\*기본 목록\*\*: (.+)$/m.exec(adr)?.[1] ?? "";
    expect([...listed.matchAll(/`(\w+)`/g)].map((m) => m[1])).toEqual([
      ...DEFAULT_ENABLED_STRATEGIES,
    ]);
  });
});
