// Temporary module: the real json implementation replaces this file (I02A, T01 stub).
import { formatFailure } from "../text-builder.ts";
import type { TextFormatModule } from "../types.ts";

export const jsonModule: TextFormatModule = {
  format: "json",
  input: "text",
  parse() {
    return formatFailure("unsupported-format", "json module is not implemented yet");
  },
};
