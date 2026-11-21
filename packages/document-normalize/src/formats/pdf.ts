// Temporary module: the real pdf implementation replaces this file (I02A, T01 stub).
import { formatFailure } from "../text-builder.ts";
import type { BinaryFormatModule } from "../types.ts";

export const pdfModule: BinaryFormatModule = {
  format: "pdf",
  input: "bytes",
  parse() {
    return formatFailure("unsupported-format", "pdf module is not implemented yet");
  },
};
