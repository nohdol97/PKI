// Temporary module: the real csv implementation replaces this file (I02A, T01 stub).
import { formatFailure } from "../text-builder.ts";
import type { TextFormatModule } from "../types.ts";

export const csvModule: TextFormatModule = {
  format: "csv",
  input: "text",
  parse() {
    return formatFailure("unsupported-format", "csv module is not implemented yet");
  },
};
