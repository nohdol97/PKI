// Temporary module: the real txt implementation replaces this file (I02A, T01 stub).
import { formatFailure } from "../text-builder.ts";
import type { TextFormatModule } from "../types.ts";

export const txtModule: TextFormatModule = {
  format: "txt",
  input: "text",
  parse() {
    return formatFailure("unsupported-format", "txt module is not implemented yet");
  },
};
