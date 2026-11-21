// The pipeline of I02A: read and check the input, decide the format, decode text,
// call the format module, and return a result. Failures are results, never rejections
// (I02A-R5); only a bad limits object (a caller bug) throws.
import { decodeText } from "./encoding.ts";
import { detectFormat } from "./detect.ts";
import { csvModule } from "./formats/csv.ts";
import { docxModule } from "./formats/docx.ts";
import { htmlModule } from "./formats/html.ts";
import { jsonModule } from "./formats/json.ts";
import { markdownModule } from "./formats/markdown.ts";
import { pdfModule } from "./formats/pdf.ts";
import { txtModule } from "./formats/txt.ts";
import { xlsxModule } from "./formats/xlsx.ts";
import { readInput } from "./input.ts";
import { resolveLimits } from "./limits.ts";
import { formatFailure } from "./text-builder.ts";
import { LIMITATION_CODES } from "./types.ts";
import type {
  DocumentFormat,
  FormatModule,
  FormatResult,
  Limitation,
  NormalizeInput,
  NormalizeOptions,
  NormalizeResult,
} from "./types.ts";

/** One module per format; the registry the pipeline calls through (tests spy on `parse`). */
export const FORMAT_MODULES = {
  pdf: pdfModule,
  markdown: markdownModule,
  txt: txtModule,
  html: htmlModule,
  docx: docxModule,
  xlsx: xlsxModule,
  csv: csvModule,
  json: jsonModule,
} as const satisfies Record<DocumentFormat, FormatModule>;

const DETAIL_LIMIT = 300;

function corrupt(error: unknown) {
  const cause = error instanceof Error ? error.message : String(error);
  return formatFailure("corrupt", "파일을 해석하지 못했다", {
    cause: cause.slice(0, DETAIL_LIMIT),
  });
}

/** Runs a module; a throw or rejection becomes `corrupt` (I02A-R5). */
async function run(
  module: FormatModule,
  content: string | Uint8Array,
  limits: ReturnType<typeof resolveLimits>,
): Promise<FormatResult> {
  try {
    return module.input === "text"
      ? await module.parse(content as string, limits)
      : await module.parse(content as Uint8Array, limits);
  } catch (error) {
    return corrupt(error);
  }
}

const orderOf = (l: Limitation) => LIMITATION_CODES.indexOf(l.code);

export async function normalizeDocument(
  input: NormalizeInput,
  options: NormalizeOptions = {},
): Promise<NormalizeResult> {
  const limits = resolveLimits(options.limits);

  try {
    const read = await readInput(input, limits);
    if (!read.ok) return read;

    const detected = detectFormat(read.name, input.format, read.bytes);
    if (!detected.ok) return detected;
    const module = FORMAT_MODULES[detected.format];

    let result: FormatResult;
    let encoding;
    if (module.input === "bytes") {
      result = await run(module, read.bytes, limits);
    } else {
      const decoded = decodeText(read.bytes, limits.encoding);
      if (!decoded.ok) {
        return formatFailure(
          "encoding-undecidable",
          "BOM, UTF-8, EUC-KR 어느 것으로도 깨끗이 풀리지 않는다",
        );
      }
      encoding = decoded.encoding;
      result = await run(module, decoded.text.replace(/\r\n?/g, "\n"), limits);
    }
    if (!result.ok) return result;

    const limitations: Limitation[] = [...result.value.limitations];
    if (encoding?.method === "fallback") limitations.push({ code: "text.encoding-fallback" });
    limitations.sort((a, b) => orderOf(a) - orderOf(b));

    return {
      ok: true,
      document: {
        format: detected.format,
        text: result.value.text,
        blocks: result.value.blocks,
        metadata: result.value.metadata,
        ...(encoding ? { encoding } : {}),
        limitations,
      },
    };
  } catch (error) {
    return corrupt(error);
  }
}
