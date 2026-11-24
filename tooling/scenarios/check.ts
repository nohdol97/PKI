// `pnpm check:scenarios [--release] [--write]` (H03-C3-R5): the entry point; the work is in final-scenarios.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runScenarioCheck } from "./final-scenarios.ts";

const ROOT = resolve(import.meta.dirname, "../..");

process.exitCode = runScenarioCheck(process.argv.slice(2), {
  loadMap: () => JSON.parse(readFileSync(resolve(ROOT, "eval/final-scenarios.json"), "utf8")),
  read: (path) => {
    const file = resolve(ROOT, path);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  },
  out: (line) => console.log(line),
  writeDoc: (text) => writeFileSync(resolve(ROOT, "docs/FINAL_SCENARIOS.md"), text),
});
