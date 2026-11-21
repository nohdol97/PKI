// Temporary module: the real docx implementation replaces this file (I02A, T01 stub).
import { formatFailure } from "../text-builder.ts";
import type { BinaryFormatModule } from "../types.ts";

export const docxModule: BinaryFormatModule = {
  format: "docx",
  input: "bytes",
  parse() {
    return formatFailure("unsupported-format", "docx module is not implemented yet");
  },
};
