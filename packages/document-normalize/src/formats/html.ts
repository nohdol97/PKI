// Temporary module: the real html implementation replaces this file (I02A, T01 stub).
import { formatFailure } from "../text-builder.ts";
import type { TextFormatModule } from "../types.ts";

export const htmlModule: TextFormatModule = {
  format: "html",
  input: "text",
  parse() {
    return formatFailure("unsupported-format", "html module is not implemented yet");
  },
};
