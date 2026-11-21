// DOCX (I02A-R11): paragraphs in document order through mammoth's document tree,
// after the zip guard. Nothing is executed, no external file is opened (R6).
import mammoth from "mammoth";
import {
  attributeValue,
  entryText,
  openOoxml,
  readCoreProperties,
  scanXml,
} from "../ooxml-core.ts";
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

const SEPARATOR_NOTES = new Set(["separator", "continuationSeparator", "continuationNotice"]);

/** Whether a part has an opening tag with one of these local names. */
function hasElement(xml: string, names: ReadonlySet<string>): boolean {
  let found = false;
  scanXml(xml, (t) => (found = t.kind === "open" && names.has(t.name)));
  return found;
}

/** A `<t>` element whose content is a non-empty text node. */
function hasTextRun(xml: string): boolean {
  let inRun = false;
  let hasText = false;
  let found = false;
  scanXml(xml, (t) => {
    if (t.kind === "open") {
      inRun = t.name === "t" && !t.selfClosing;
      hasText = false;
    } else if (t.kind === "text") {
      hasText = inRun;
    } else {
      found = inRun && hasText && t.name === "t";
      inRun = false;
    }
    return found;
  });
  return found;
}

/** A footnote or endnote that is not one of Word's separator notes. */
function hasRealNote(xml: string): boolean {
  let found = false;
  scanXml(xml, (t) => {
    if (t.kind === "open" && (t.name === "footnote" || t.name === "endnote")) {
      found = !SEPARATOR_NOTES.has(attributeValue(t.attributes, "type") ?? "");
    }
    return found;
  });
  return found;
}

const PICTURE = new Set(["blip", "imagedata"]);
const COMMENT = new Set(["comment"]);

function limitations(pkg: OoxmlPackage): Limitation[] {
  const names = [...pkg.entries.keys()];
  const found: Limitation[] = [];
  if (
    names.some((n) => n.startsWith("word/media/")) ||
    hasElement(entryText(pkg, "word/document.xml"), PICTURE)
  ) {
    found.push({ code: "docx.images-omitted" });
  }
  if (
    names.some((n) => /^word\/(?:header|footer)\d*\.xml$/.test(n) && hasTextRun(entryText(pkg, n)))
  ) {
    found.push({ code: "docx.headers-footers-omitted" });
  }
  if (
    hasRealNote(entryText(pkg, "word/footnotes.xml")) ||
    hasRealNote(entryText(pkg, "word/endnotes.xml"))
  ) {
    found.push({ code: "docx.notes-omitted" });
  }
  if (hasElement(entryText(pkg, "word/comments.xml"), COMMENT)) {
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
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
  },
};
