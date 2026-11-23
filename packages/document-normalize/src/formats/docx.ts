// DOCX (I02A-R11): paragraphs in document order through mammoth's document tree,
// after the zip guard. Nothing is executed, no external file is opened (R6).
import mammoth from "mammoth";
import {
  attributeValue,
  decodeReferences,
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
  commentId?: string;
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

/** The ids of the comments referenced anywhere inside a paragraph. */
function referencedComments(node: Node, into: string[]): void {
  for (const child of node.children ?? []) {
    if (child.type === "commentReference" && child.commentId !== undefined)
      into.push(child.commentId);
    else referencedComments(child, into);
  }
}

/** Writes the body into `builder`; returns the paragraph number each comment id is attached to. */
function collect(document: Node, builder: TextBuilder): Map<string, number> {
  const anchors = new Map<string, number>();
  let paragraph = 0;
  let tables = 0;
  const walk = (nodes: Node[], table?: { index: number; row: number; cell: number }) => {
    for (const node of nodes) {
      if (node.type === "paragraph") {
        const ids: string[] = [];
        referencedComments(node, ids);
        for (const id of ids) if (!anchors.has(id)) anchors.set(id, paragraph);
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
  return anchors;
}

interface Comment {
  /** `w:id`, also the file-order number the ties of I02B-R30 fall back to. */
  id: string;
  number: number;
  author?: string;
  date?: string;
  text: string;
  /** `w14:paraId` of the comment's last paragraph: what a reply names as its parent. */
  paraId?: string;
}

/** The comments of `word/comments.xml` in file order (I02B-R30). One linear pass over the part. */
function readComments(xml: string): Comment[] {
  const comments: Comment[] = [];
  let current: Comment | undefined;
  let paragraphs: string[] = [];
  let inParagraph = false;
  let inText = false;
  scanXml(xml, (t) => {
    if (t.kind === "open") {
      if (t.name === "comment") {
        current = {
          id: attributeValue(t.attributes, "id") ?? "",
          number: comments.length,
          text: "",
        };
        const author = attributeValue(t.attributes, "author")?.trim();
        const date = attributeValue(t.attributes, "date")?.trim();
        if (author) current.author = author;
        if (date) current.date = date;
        paragraphs = [];
        if (t.selfClosing) {
          comments.push(current);
          current = undefined;
        }
      } else if (current && t.name === "p") {
        paragraphs.push("");
        inParagraph = !t.selfClosing;
        const paraId = attributeValue(t.attributes, "paraId");
        if (paraId !== undefined) current.paraId = paraId;
      } else if (current && inParagraph && t.name === "t") inText = !t.selfClosing;
      else if (current && inParagraph && t.name === "tab")
        paragraphs[paragraphs.length - 1] += "\t";
      else if (current && inParagraph && (t.name === "br" || t.name === "cr")) {
        paragraphs[paragraphs.length - 1] += "\n";
      }
    } else if (t.kind === "text") {
      if (current && inText) paragraphs[paragraphs.length - 1] += decodeReferences(t.value);
    } else if (t.name === "t") inText = false;
    else if (t.name === "p") inParagraph = false;
    else if (t.name === "comment" && current) {
      current.text = paragraphs.join("\n").trim();
      comments.push(current);
      current = undefined;
    }
    return false;
  });
  return comments;
}

/** `paraId` → `paraIdParent` of `word/commentsExtended.xml`: which comment answers which. */
function readParents(xml: string): Map<string, string> {
  const parents = new Map<string, string>();
  scanXml(xml, (t) => {
    if (t.kind === "open" && t.name === "commentEx") {
      const id = attributeValue(t.attributes, "paraId");
      const parent = attributeValue(t.attributes, "paraIdParent");
      if (id !== undefined && parent !== undefined) parents.set(id, parent);
    }
    return false;
  });
  return parents;
}

const DATE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * The instant a comment's `w:date` names, for ordering only. A date without an offset is read as UTC
 * (Word's value is as written, G12, and the order must not depend on the machine's time zone).
 */
function instant(date: string | undefined): number | undefined {
  const match = date === undefined ? null : DATE.exec(date);
  const ms = match ? Date.parse(`${match[1]}${match[2] ?? "Z"}`) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

/** Earlier first; a comment without a readable date after the dated ones; then the file's number. */
function byTime(a: Comment, b: Comment): number {
  const x = instant(a.date);
  const y = instant(b.date);
  if (x !== undefined && y !== undefined && x !== y) return x - y;
  if ((x === undefined) !== (y === undefined)) return x === undefined ? 1 : -1;
  return a.number - b.number;
}

/** Threads (a first comment and its answers), threads by the first comment's time, answers by time (I02B-R30). */
function threads(comments: Comment[], parents: Map<string, string>): Comment[][] {
  const byParaId = new Map(comments.flatMap((c) => (c.paraId ? [[c.paraId, c] as const] : [])));
  const rootOf = (comment: Comment): Comment => {
    let at = comment;
    for (let hops = 0; hops <= comments.length; hops++) {
      const parent =
        at.paraId === undefined ? undefined : byParaId.get(parents.get(at.paraId) ?? "");
      if (parent === undefined || parent === at) return at;
      at = parent;
    }
    return comment;
  };
  const grouped = new Map<Comment, Comment[]>();
  for (const comment of comments) {
    const root = rootOf(comment);
    grouped.set(root, [...(grouped.get(root) ?? []), comment]);
  }
  return [...grouped.values()]
    .map((members) => members.sort(byTime))
    .sort((a, b) => byTime(a[0] as Comment, b[0] as Comment));
}

/** What the host protocol accepts of `metadata.participants`: names of at most this many code units, at most this many names. */
const MAX_PARTICIPANT_UNITS = 1_024;
const MAX_PARTICIPANTS = 10_000;

/** A name cut to the protocol's length without splitting a surrogate pair. */
function boundedName(name: string): string {
  if (name.length <= MAX_PARTICIPANT_UNITS) return name;
  const end = /[\ud800-\udbff]/.test(name[MAX_PARTICIPANT_UNITS - 1] ?? "")
    ? MAX_PARTICIPANT_UNITS - 1
    : MAX_PARTICIPANT_UNITS;
  return name.slice(0, end);
}

/** The comments after the body: a head (author and time) and a text block each, `\n\n` after the body. */
function appendComments(
  builder: TextBuilder,
  pkg: OoxmlPackage,
  anchors: Map<string, number>,
): string[] {
  const comments = readComments(entryText(pkg, "word/comments.xml"));
  const participants: string[] = [];
  const seen = new Set<string>();
  let first = true;
  threads(comments, readParents(entryText(pkg, "word/commentsExtended.xml"))).forEach((thread, t) =>
    thread.forEach((comment, index) => {
      const paragraph = anchors.get(comment.id) ?? 0;
      const at = (part: "head" | "text"): Extract<Locator, { format: "docx" }> => ({
        format: "docx",
        paragraph,
        comment: { thread: t, index, part },
      });
      const head = [comment.author, comment.date].filter((v) => v !== undefined).join(" ");
      builder.block(head, at("head"), first ? "\n\n" : "\n");
      builder.block(comment.text, at("text"));
      first = false;
      const name = comment.author === undefined ? undefined : boundedName(comment.author);
      if (name !== undefined && participants.length < MAX_PARTICIPANTS && !seen.has(name)) {
        seen.add(name);
        participants.push(name);
      }
    }),
  );
  return participants;
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
      let anchors = new Map<string, number>();
      await mammoth.convertToHtml(
        { buffer: Buffer.from(pkg.rezipped) },
        {
          externalFileAccess: false,
          includeDefaultStyleMap: false,
          includeEmbeddedStyleMap: false,
          ignoreEmptyParagraphs: false,
          convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
          transformDocument: (document: Node) => {
            anchors = collect(document, builder);
            return document;
          },
        },
      );
      const participants = appendComments(builder, pkg, anchors);
      const metadata = readCoreProperties(pkg);
      if (participants.length > 0) metadata.participants = participants;
      return formatSuccess(builder.finish({ metadata, limitations: limitations(pkg) }));
    } catch (error) {
      return formatFailure("corrupt", "DOCX를 해석하지 못했다", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
  },
};
