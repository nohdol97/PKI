// The command that measures X01-R18: runs the ablation on dev at corpus T0, writes each configuration's predictions
// file, scores them with eval/scorer/score.py, and writes eval/results/x01-dev-t0.json (results, keep-rule
// numbers, environment, commands). Test-support, not product: it builds the embedder (an adapter) and the memory
// vector index (a test double), which only a composition point or a test file may.
//
//   pnpm exec node backend/src/retrieval-ablation.main.test-support.ts \
//     --out eval/results [--name x01-dev-t0] [--pack <absolute folder of the pinned bge-m3 files>] [--without-vector]
//
// `--without-vector` leaves C2 out on purpose, so C3-C5 are the chain without the vector (the default list has none).
import { createLocalEmbedder } from "@pki/providers/adapters";
import { MemoryVectorIndex } from "@pki/testkit";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, arch, release, tmpdir, totalmem, type } from "node:os";
import { join, resolve } from "node:path";
import { runAblation, type AblationVector, type ConfigRun } from "./retrieval-ablation.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const outDir = resolve(flag("--out") ?? join(ROOT, "eval/results"));
const pack = flag("--pack");
const withoutVector = process.argv.includes("--without-vector");
const name = flag("--name") ?? "x01-dev-t0";
const GOLDEN = join(ROOT, "eval/golden");
const SCORER = join(ROOT, "eval/scorer/score.py");
const PREDICTIONS_DIR = join(outDir, `${name}-predictions`);

const run$ = (command: string, args: string[]) =>
  spawnSync(command, args, { encoding: "utf8", cwd: ROOT });
const git = (...args: string[]) => run$("git", ["-C", ROOT, ...args]).stdout.trim();

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const modelsDir = mkdtempSync(join(tmpdir(), "pki-ablation-models-"));
let vector: AblationVector | undefined;
let vectorNotMeasured: string | undefined;
let embeddingModel: unknown = null;
if (withoutVector) {
  vectorNotMeasured =
    "left out on purpose: the chain without the vector (the default list has none)";
} else if (pack === undefined) {
  vectorNotMeasured = "no local model pack was given (--pack); nothing was downloaded";
} else {
  const embedding = createLocalEmbedder(modelsDir);
  try {
    await embedding.prepare(
      { kind: "local-pack", path: resolve(pack) },
      new AbortController().signal,
    );
    vector = { embedding, index: new MemoryVectorIndex() };
    embeddingModel = embedding.describe();
  } catch (error) {
    vectorNotMeasured = `the local model pack could not be prepared: ${(error as Error).message}`;
  }
}

const started = new Date();
const result = await runAblation({ goldenDir: GOLDEN, split: "dev", vector, vectorNotMeasured });
rmSync(modelsDir, { recursive: true, force: true });

mkdirSync(PREDICTIONS_DIR, { recursive: true });
const score = (file: string, k: number) => {
  const scored = run$("python3", ["-I", SCORER, GOLDEN, file, "--split", "dev", "--k", String(k)]);
  if (scored.status !== 0) throw new Error(`score.py failed: ${scored.stderr}`);
  return (JSON.parse(scored.stdout) as { retrieval: Record<string, number> }).retrieval;
};

const measured = result.configs.filter(
  (c): c is Extract<ConfigRun, { status: "measured" }> => c.status === "measured",
);
const byId = new Map(measured.map((c) => [c.id, c]));
const configs = result.configs.map((config) => {
  if (config.status !== "measured") return config;
  const file = join(PREDICTIONS_DIR, `${config.id}.jsonl`);
  writeFileSync(file, `${config.lines.join("\n")}\n`);
  const at5 = score(file, 5);
  const at10 = score(file, 10);
  // the runner's own per-question figures must be the ones score.py averages
  const own = Object.values(config.perQuestion);
  if (Math.abs(mean(own.map((q) => q.recall)) - (at5.recall_at_k as number)) > 1e-9) {
    throw new Error(`${config.id}: the runner's Recall@5 differs from score.py's`);
  }
  const sorted = [...config.latencyMs].sort((a, b) => a - b);
  const latency = {
    queries: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
  const base = config.base === null ? undefined : byId.get(config.base);
  const baseAt5 = base ? score(join(PREDICTIONS_DIR, `${base.id}.jsonl`), 5) : undefined;
  let keepRule: Record<string, unknown> | null = null;
  if (base && baseAt5) {
    let improved = 0;
    let worsened = 0;
    for (const [id, q] of Object.entries(config.perQuestion)) {
      const b = base.perQuestion[id] as { recall: number; rr: number };
      const delta = q.recall - b.recall || q.rr - b.rr;
      if (delta > 1e-12) improved++;
      else if (delta < -1e-12) worsened++;
    }
    const recallDelta = (at5.recall_at_k as number) - (baseAt5.recall_at_k as number);
    const mrrDelta = (at5.mrr as number) - (baseAt5.mrr as number);
    const baseLatency = [...base.latencyMs].sort((a, b) => a - b);
    const ratio = latency.p95Ms / percentile(baseLatency, 0.95);
    keepRule = {
      comparedWith: base.id,
      A_gain: {
        recallDelta,
        mrrDelta,
        improvedQuestions: improved,
        worsenedQuestions: worsened,
        net: improved - worsened,
        passes: (recallDelta >= 0.02 || mrrDelta >= 0.02) && improved - worsened >= 1,
      },
      B_noRegression: "not measured: no answers or citations exist without a Provider",
      C_cost: { p95RatioToBase: ratio, passesTwiceBase: ratio <= 2, absoluteCapChecked: false },
    };
  }
  return {
    id: config.id,
    name: config.name,
    status: config.status,
    strategies: config.strategies,
    predictions: `eval/results/${name}-predictions/${config.id}.jsonl`,
    retrieval: at5,
    retrievalAt10: at10,
    latency,
    routeUsed: config.routeUsed,
    keepRule,
  };
});

const cpu = cpus();
const out = {
  task: "X01-T4 (issue #30)",
  split: "dev",
  corpus: {
    tier: "T0",
    note: "the whole golden corpus (155 source lines) and no background documents; only dev questions are asked",
    lines: result.corpus.lines,
    received: result.corpus.received,
    importErrors: result.corpus.errors,
  },
  questions: { ...result.questions, k: 5 },
  seededKnowledge: {
    note: "planted from the dev labels with no Provider: the figures of C3-C5 are the upper bound when extraction is perfect",
    ...result.seeded,
  },
  environment: {
    ranAt: started.toISOString(),
    hardware: {
      cpu: cpu[0]?.model,
      logicalCores: cpu.length,
      ramGiB: Math.round(totalmem() / 2 ** 30),
      os: `${type()} ${release()} ${arch()}`,
      gpu: "none used (CPU runtime)",
      storage: "not recorded",
      grade:
        "neither A nor B (EVALUATION 4.4 names Windows 11 machines); latency here is indicative only",
    },
    node: process.version,
    python: run$("python3", ["--version"]).stdout.trim(),
    embeddingModel,
    productCommit: git("rev-parse", "HEAD"),
    datasetCommit: git("log", "-1", "--format=%H", "--", "eval/golden"),
    workingTreeClean: git("status", "--porcelain", "--", ".", ":!eval/results") === "",
  },
  commands: [
    `pnpm exec node backend/src/retrieval-ablation.main.test-support.ts --out eval/results --name ${name}${withoutVector ? " --without-vector" : pack ? " --pack <local pack folder>" : ""}`,
    `python3 -I eval/scorer/score.py eval/golden eval/results/${name}-predictions/<C>.jsonl --split dev --k 5`,
    `python3 -I eval/scorer/score.py eval/golden eval/results/${name}-predictions/<C>.jsonl --split dev --k 10`,
  ],
  configs,
  notMeasured: [
    "Answer Groundedness and Citation Accuracy: no Provider answers exist here (a fake's answer is not a measurement)",
    "T1 and T2 corpora (background documents), retrieval latency against the absolute caps, the eval split",
  ],
};
writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(out, null, 2)}\n`);
