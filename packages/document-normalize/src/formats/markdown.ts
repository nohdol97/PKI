// Temporary module: the real markdown implementation replaces this file (I02A, T01 stub).
import { formatFailure } from "../text-builder.ts";
import type { TextFormatModule } from "../types.ts";

export const markdownModule: TextFormatModule = {
  format: "markdown",
  input: "text",
  parse() {
    return formatFailure("unsupported-format", "markdown module is not implemented yet");
  },
};
