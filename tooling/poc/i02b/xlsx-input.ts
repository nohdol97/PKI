/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway): the large XLSX that killed a 512 MB-heap worker in the G2 follow-up:
// 4 sheets x 22,000 rows x 40 columns of numbers (88,000 rows in total), 9.6 MiB as a file.
// Deterministic: the same call gives the same bytes. Usage: node xlsx-input.ts <outFile>
import { writeFileSync } from "node:fs";
import { buildXlsx } from "../../../packages/document-normalize/src/testing/ooxml-builder.ts";

export function makeTriggerXlsx(rowsPerSheet = 22_000): Uint8Array {
  const row = (r: number) => Array.from({ length: 40 }, (_, c) => r * 40 + c);
  const sheets = Array.from({ length: 4 }, (_, i) => ({
    name: `S${i + 1}`,
    rows: Array.from({ length: rowsPerSheet }, (_, r) => row(r)),
  }));
  return buildXlsx({ sheets });
}

if (import.meta.main && import.meta.filename.endsWith("xlsx-input.ts")) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: xlsx-input.ts <outFile>");
  const bytes = makeTriggerXlsx();
  writeFileSync(out, bytes);
  console.log(
    `wrote ${bytes.length} bytes (${(bytes.length / 1024 ** 2).toFixed(1)} MiB) to ${out}`,
  );
}
