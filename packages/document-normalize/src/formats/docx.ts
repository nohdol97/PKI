// DOCX (I02A-R11): paragraphs in document order through mammoth's document tree,
// after the zip guard. Nothing is executed, no external file is opened (R6).
import mammoth from "mammoth";
import { entryText, openOoxml, readCoreProperties } from "../ooxml-core.ts";
import type { OoxmlPackage } from "../ooxml-core.ts";
import { TextBuilder, formatFailure, formatSuccess } from "../text-builder.ts";
import type { BinaryFormatModule, Limitation, Locator } from "../types.ts";

/** The part of mammoth's document tree this module reads. */
interface Node {
  type: string;
  children?: Node[];
  value?: string;
  breakType?: string;
  styleId?: string | null;
  styleName?: string | null;
}

/** Text of a paragraph: runs and hyperlinks, a tab as `\t`, a line break as `\n`. */
function paragraphText(node: Node): string {
  let text = "";
  for (const child of node.children ?? []) {
    if (child.type === "text") text += child.value ?? "";
    else if (child.type === "tab") text += "\t";
    else if (child.type === "break") text += child.breakType === "line" ? "\n" : "";
    else text += paragraphText(child);
  }
  return text;
}

function collect(document: Node, builder: TextBuilder): void {
  let paragraph = 0;
  let tables = 0;
  const walk = (nodes: Node[], table?: { index: number; row: number; cell: number }) => {
    for (const node of nodes) {
      if (node.type === "paragraph") {
        const locator: Extract<Locator, { format: "docx" }> = {
          format: "docx",
          paragraph: paragraph++,
        };
        const style = node.styleName ?? node.styleId;
        if (typeof style === "string") locator.style = style;
        const level = /^heading\s+(\d+)$/i.exec(node.styleName ?? "")?.[1];
        if (level !== undefined) locator.headingLevel = Number(level);
        if (table) locator.table = table;
        builder.block(paragraphText(node), locator);
      } else if (node.type === "table") {
        const index = tables++;
        (node.children ?? []).forEach((row, r) =>
          (row.children ?? []).forEach((cell, c) =>
            walk(cell.children ?? [], { index, row: r, cell: c }),
          ),
        );
      }
    }
  };
  walk(document.children ?? []);
}

const TAG = (name: string) => new RegExp(`<(?:\\w+:)?${name}[\\s>/]`);
const NOTE_ITEM = /<(?:\w+:)?(?:footnote|endnote)\b([^>]*)>/g;
const SEPARATOR_NOTE = /\btype\s*=\s*"(?:separator|continuationSeparator|continuationNotice)"/;
const TEXT_RUN = /<(?:\w+:)?t(?:\s[^>]*)?>[^<]+<\/(?:\w+:)?t>/;

function limitations(pkg: OoxmlPackage): Limitation[] {
  const names = [...pkg.entries.keys()];
  const found: Limitation[] = [];
  const body = entryText(pkg, "word/document.xml");
  if (
    names.some((n) => n.startsWith("word/media/")) ||
    /<(?:\w+:)?(?:blip|imagedata)[\s>/]/.test(body)
  ) {
    found.push({ code: "docx.images-omitted" });
  }
  if (
    names.some(
      (n) => /^word\/(?:header|footer)\d*\.xml$/.test(n) && TEXT_RUN.test(entryText(pkg, n)),
    )
  ) {
    found.push({ code: "docx.headers-footers-omitted" });
  }
  const realNote = (part: string) =>
    [...entryText(pkg, part).matchAll(NOTE_ITEM)].some((m) => !SEPARATOR_NOTE.test(m[1] ?? ""));
  if (realNote("word/footnotes.xml") || realNote("word/endnotes.xml")) {
    found.push({ code: "docx.notes-omitted" });
  }
  if (TAG("comment").test(entryText(pkg, "word/comments.xml"))) {
    found.push({ code: "docx.comments-omitted" });
  }
  return found;
}

export const docxModule: BinaryFormatModule = {
  format: "docx",
  input: "bytes",
  async parse(bytes, limits) {
    try {
      const opened = await openOoxml(bytes, limits, "word/document.xml");
      if (!opened.ok) return opened;
      const { pkg } = opened;

      const builder = new TextBuilder();
      await mammoth.convertToHtml(
        { buffer: Buffer.from(pkg.rezipped) },
        {
          externalFileAccess: false,
          includeDefaultStyleMap: false,
          includeEmbeddedStyleMap: false,
          ignoreEmptyParagraphs: false,
          convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
          transformDocument: (document: Node) => {
            collect(document, builder);
            return document;
          },
        },
      );
      return formatSuccess(
        builder.finish({ metadata: readCoreProperties(pkg), limitations: limitations(pkg) }),
      );
    } catch (error) {
      return formatFailure("corrupt", "DOCX를 해석하지 못했다", {
        cause: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  },
};
