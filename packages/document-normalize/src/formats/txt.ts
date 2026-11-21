// TXT: the decoded text is the canonical text; each non-blank line is a block (I02A-R16).
import { verbatimLineBlocks } from "../text-builder.ts";
import type { TextFormatModule } from "../types.ts";

export const txtModule: TextFormatModule = {
  format: "txt",
  input: "text",
  parse(text) {
    return { ok: true, value: verbatimLineBlocks(text, "txt") };
  },
};
