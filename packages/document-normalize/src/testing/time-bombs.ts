// Inputs that make the normalizer slow or heavy (I02B-R25, test code). The two reproduction inputs of
// the I02-A review are not files in the repository: these functions rebuild the same kind of bytes
// every time (same arguments, same bytes). `bomb-worker.ts` is the test worker that needs no parser.
import { createDeflate } from "node:zlib";
import { buildXlsx } from "./ooxml-builder.ts";

/** A run of unmatched emphasis delimiters: micromark's emphasis resolution goes quadratic on it. */
export function makeSlowMarkdown(units = 8_000): Uint8Array {
  return new TextEncoder().encode("_*a".repeat(units));
}

/**
 * One page whose content stream is a FlateDecode stream that inflates to `inflatedBytes` of `q Q `
 * operators (about 1000:1): PDF.js inflates and interprets all of it. Whitespace alone ends in seconds.
 */
export async function makePdfBomb(inflatedBytes = 3 * 1024 ** 3): Promise<Uint8Array> {
  const deflate = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => parts.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on("end", resolve);
    deflate.on("error", reject);
  });
  const fill = "q Q ";
  const block = Buffer.from(fill.repeat(1024 ** 2 / fill.length), "latin1");
  for (let written = 0; written < inflatedBytes; written += block.length) {
    const piece = block.subarray(0, Math.min(block.length, inflatedBytes - written));
    if (!deflate.write(piece)) await new Promise((resolve) => deflate.once("drain", resolve));
  }
  deflate.end();
  await done;
  const stream = Buffer.concat(parts);

  const text = (s: string) => Buffer.from(s, "latin1");
  const objects = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Count 1 /Kids [3 0 R] >>"),
    text(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    ),
    Buffer.concat([
      text(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
      stream,
      text("\nendstream"),
    ]),
  ];
  const out: Buffer[] = [text("%PDF-1.4\n")];
  const offsets: number[] = [];
  let at = out[0]?.length ?? 0;
  objects.forEach((body, i) => {
    offsets.push(at);
    const piece = Buffer.concat([text(`${i + 1} 0 obj\n`), body, text("\nendobj\n")]);
    out.push(piece);
    at += piece.length;
  });
  out.push(
    text(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(out));
}

/**
 * The XLSX that was seen to abort a whole process at a 512 MB worker heap (I02B-T01, G19): 4 sheets of
 * 22,000 rows x 40 numeric columns, 9.6 MiB as a file. `rowsPerSheet` scales it down for tests that
 * only need a large file.
 */
export function makeTriggerXlsx(rowsPerSheet = 22_000): Uint8Array {
  const row = (r: number) => Array.from({ length: 40 }, (_, c) => r * 40 + c);
  const sheets = Array.from({ length: 4 }, (_, i) => ({
    name: `S${i + 1}`,
    rows: Array.from({ length: rowsPerSheet }, (_, r) => row(r)),
  }));
  return buildXlsx({ sheets });
}

/** The job names `bomb-worker.ts` answers to; any other name is normalized as an ordinary file. */
export const BOMB = {
  /** A synchronous loop that never yields. */
  loop: "bomb:loop",
  /** Fills the V8 heap with objects until the heap limit ends the worker. */
  heap: "bomb:heap",
  /** Takes Buffers in a synchronous loop (outside the V8 heap), at most 3x the host's external limit. */
  external: "bomb:external",
  /** An error that is not about memory. */
  error: "bomb:error",
  /** Takes up the worker for a while without memory: for a kill that arrives mid-job. */
  wait: "bomb:wait",
} as const;
