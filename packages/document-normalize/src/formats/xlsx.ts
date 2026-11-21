// Temporary module: the real xlsx implementation replaces this file (I02A, T01 stub).
import { formatFailure } from "../text-builder.ts";
import type { BinaryFormatModule } from "../types.ts";

export const xlsxModule: BinaryFormatModule = {
  format: "xlsx",
  input: "bytes",
  parse() {
    return formatFailure("unsupported-format", "xlsx module is not implemented yet");
  },
};
