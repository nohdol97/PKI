// JSON: parsed once as a validity check, then kept verbatim like TXT; the structure
// is not flattened (I02A-R16).
import { formatFailure, verbatimLineBlocks } from "../text-builder.ts";
import type { TextFormatModule } from "../types.ts";

export const jsonModule: TextFormatModule = {
  format: "json",
  input: "text",
  parse(text) {
    try {
      JSON.parse(text);
    } catch {
      // The SyntaxError message can quote the document, so it is not passed on.
      return formatFailure("corrupt", "the file is not valid JSON");
    }
    return { ok: true, value: verbatimLineBlocks(text, "json") };
  },
};
