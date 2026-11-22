// Builds the synthetic manifest from every synthetic item the product can ingest
// or send: the test Connector fixtures, the golden sources (R05) and the fixed
// connection-test material. Run `pnpm --filter @pki/providers build:synthetic-manifest`
// after changing any of them and commit the result; synthetic-manifest.test.ts
// fails while the committed file differs from a fresh build. `--check [FILE]`
// (`check:synthetic-manifest`, run by the production build, V01-T15) writes
// nothing and exits 1 while FILE (default: the committed one) differs.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { syntheticHash } from "./synthetic-manifest.ts";

export interface ManifestEntry {
  hash: string;
  malicious: boolean;
  source: string;
}

interface Item {
  title: string;
  body: string;
  malicious: boolean;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`${where}: expected a string`);
  return value;
}

function jsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const jsonlFiles = (dir: string) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(dir, name));

export function buildSyntheticManifest(root: string): ManifestEntry[] {
  const inputs: [string, Item[]][] = [
    ...jsonlFiles(join(root, "fixtures")).map((file): [string, Item[]] => [
      file,
      jsonl(file).map((r, i) => {
        // Test Connector lines carry `body`; JSONL import lines (V02-R1) carry `content`.
        const field = "schema_version" in r ? "content" : "body";
        return {
          title: text(r.title, `${file}:${i + 1} title`),
          body: text(r[field], `${file}:${i + 1} ${field}`),
          malicious: r.malicious === true,
        };
      }),
    ]),
    // Golden delete records carry an empty body and are never ingested as content.
    ...jsonlFiles(join(root, "eval", "golden", "sources")).map((file): [string, Item[]] => [
      file,
      jsonl(file)
        .filter((r) => r.operation !== "delete")
        .map((r, i) => ({
          title: text(r.title, `${file}:${i + 1} title`),
          body: text(r.content, `${file}:${i + 1} content`),
          malicious: false,
        })),
    ]),
  ];
  const material = join(import.meta.dirname, "connection-test-material.json");
  const { title, body } = JSON.parse(readFileSync(material, "utf8"));
  inputs.push([
    material,
    [{ title: text(title, material), body: text(body, material), malicious: false }],
  ]);

  const byHash = new Map<string, ManifestEntry>();
  for (const [file, items] of inputs) {
    for (const item of items) {
      const hash = syntheticHash(item.title, item.body);
      const seen = byHash.get(hash);
      // The same text listed twice stays one entry; malicious if any listing says so.
      byHash.set(hash, {
        hash,
        malicious: item.malicious || (seen?.malicious ?? false),
        source: seen?.source ?? relative(root, file).replaceAll("\\", "/"),
      });
    }
  }
  return [...byHash.values()].sort((a, b) => a.hash.localeCompare(b.hash));
}

/** The manifest file's text as the build writes it. */
function render(entries: ManifestEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/** Whether `file` holds exactly what a fresh build from `root` writes. */
export function manifestIsCurrent(root: string, file: string): boolean {
  return readFileSync(file, "utf8") === render(buildSyntheticManifest(root));
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "../..");
  const out = join(import.meta.dirname, "synthetic-manifest.json");
  const [flag, file = out] = process.argv.slice(2);
  if (flag === "--check") {
    if (!manifestIsCurrent(root, file)) {
      process.stderr.write(
        "synthetic manifest is stale: run `pnpm --filter @pki/providers build:synthetic-manifest` and commit it\n",
      );
      process.exit(1);
    }
  } else {
    writeFileSync(out, render(buildSyntheticManifest(root)));
  }
}
