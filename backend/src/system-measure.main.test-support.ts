// The command that measures H03-C2 (docs/specs/2026-11-24-H03-C2-measure-runner.md): runs the measurement against a
// real backend with the stub Provider and writes eval/results/<name>.json. Test-support, not product.
//
//   pnpm exec node backend/src/system-measure.main.test-support.ts \
//     --out eval/results --name h03-c2-dev [--sources 200] [--queries 220] [--idle-seconds 30] \
//     [--soak-seconds 0] [--skip-kill]
//
// The defaults are D3's: 200 documents of about 10 KB, 220 queries (the first 20 discarded), 30 s idle, no soak.
// The kill phase keeps the product's 2-minute job lease, so a default run takes a few minutes longer.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateResult, runMeasurement } from "./system-measure.test-support.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const number = (name: string, fallback: number): number => {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} needs a number >= 0, got "${raw}"`);
  return value;
};

const outDir = resolve(flag("--out") ?? join(ROOT, "eval/results"));
const name = flag("--name") ?? "h03-c2-dev";
const { result } = await runMeasurement({
  sources: number("--sources", 200),
  queries: number("--queries", 220),
  warmup: 20,
  idleSeconds: number("--idle-seconds", 30),
  soakSeconds: number("--soak-seconds", 0),
  skipKill: process.argv.includes("--skip-kill"),
});
const problems = validateResult(result);
if (problems.length > 0) throw new Error(`the result is not valid:\n${problems.join("\n")}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
