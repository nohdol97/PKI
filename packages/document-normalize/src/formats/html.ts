// HTML to text blocks (I02A-R6, R14, R17). The document is parsed into a tree and
// walked as data: nothing runs, no address is followed.
import { parse as parseHtml } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { TextBuilder } from "../text-builder.ts";
import type { DocumentMetadata, Limitation, TextFormatModule } from "../types.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

/** R6: the content of these elements never reaches the text. */
const REMOVED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
]);

/**
 * Block-level elements: each one owns the text that sits directly in it (and in
 * its inline descendants). Anything not listed is inline and joins its nearest
 * block ancestor's text.
 */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "legend",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Attributes that carry an address. `srcset` counts once per attribute. */
const ADDRESS_ATTRIBUTES = [
  "href",
  "src",
  "srcset",
  "data",
  "action",
  "formaction",
  "poster",
  "cite",
  "background",
];

const HTML_SPACE = /[ \t\n\r\f]+/g;

function collapse(text: string): string {
  return text.replace(HTML_SPACE, " ").trim();
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

/** An address that points somewhere: not empty, not a `#fragment`, not an inline `data:` URI. */
function isExternalAddress(value: string): boolean {
  const v = value.trim();
  return v !== "" && !v.startsWith("#") && !/^data:/i.test(v);
}

function elementText(node: Node): string {
  return "value" in node && typeof node.value === "string" ? node.value : "";
}

export const htmlModule: TextFormatModule = {
  format: "html",
  input: "text",
  parse(text) {
    const document = parseHtml(text, { sourceCodeLocationInfo: true });
    const builder = new TextBuilder();
    const metadata: DocumentMetadata = {};
    let removed = 0;
    let external = 0;

    // Open chunk: raw text of the nearest block element since the last flush.
    let chunk = "";
    let chunkPre = false;
    let chunkLine = 0;
    let chunkPath = "";

    const flush = (): void => {
      const content = chunkPre ? (chunk.trim() === "" ? "" : chunk) : collapse(chunk);
      if (content !== "") {
        builder.block(content, { format: "html", path: chunkPath, line: chunkLine });
      }
      chunk = "";
    };

    const addText = (node: TextNode, path: string, pre: boolean): void => {
      const value = node.value;
      if (chunk.trim() === "" && value.trim() !== "") {
        // The chunk's text starts here: its line is this node's line plus any leading newlines.
        const leading = value.length - value.trimStart().length;
        const skipped = value.slice(0, leading).split("\n").length - 1;
        chunkLine = (node.sourceCodeLocation?.startLine ?? 1) + skipped;
        chunkPath = path;
        chunkPre = pre;
      }
      chunk += value;
    };

    const countAddresses = (element: Element): void => {
      for (const name of ADDRESS_ATTRIBUTES) {
        const value = attribute(element, name);
        if (value !== undefined && isExternalAddress(value)) external++;
      }
    };

    // `owner` is the path of the nearest block-level ancestor: the element that owns
    // the block, even when the block's first text sits inside an inline element (R14).
    const walk = (node: Node, path: string, pre: boolean, owner: string): void => {
      if (!isElement(node)) {
        if (node.nodeName === "#text") addText(node as TextNode, owner, pre);
        else if ("childNodes" in node) {
          for (const child of node.childNodes) walk(child, path, pre, owner);
        }
        return;
      }
      const name = node.tagName;
      countAddresses(node);
      if (REMOVED.has(name)) {
        removed++;
        return;
      }
      if (name === "head") {
        readHead(node);
        // script/style in the head still count as removed elements.
        for (const child of node.childNodes) {
          if (isElement(child)) {
            countAddresses(child);
            if (REMOVED.has(child.tagName)) removed++;
          }
        }
        return;
      }
      if (name === "br") {
        chunk += pre ? "\n" : " ";
        return;
      }
      if (BLOCK.has(name)) {
        flush();
        const insidePre = pre || name === "pre";
        const indexed = childPaths(node, path);
        for (const [child, childPath] of indexed) walk(child, childPath, insidePre, path);
        flush();
        return;
      }
      for (const [child, childPath] of childPaths(node, path)) walk(child, childPath, pre, owner);
    };

    const siblingPath = (parentPath: string, element: Element, index: number): string =>
      element.tagName === "body"
        ? "body"
        : `${parentPath === "" ? "" : `${parentPath}>`}${element.tagName}[${index}]`;

    const childPaths = (parent: Element, parentPath: string): Array<[Node, string]> => {
      const seen = new Map<string, number>();
      return parent.childNodes.map((child): [Node, string] => {
        if (!isElement(child)) return [child, parentPath];
        const index = (seen.get(child.tagName) ?? 0) + 1;
        seen.set(child.tagName, index);
        return [child, siblingPath(parentPath, child, index)];
      });
    };

    const readHead = (head: Element): void => {
      for (const child of head.childNodes) {
        if (!isElement(child)) continue;
        if (child.tagName === "title" && metadata.title === undefined) {
          const title = collapse(child.childNodes.map(elementText).join(""));
          if (title !== "") metadata.title = title;
        } else if (
          child.tagName === "meta" &&
          attribute(child, "name")?.toLowerCase() === "author" &&
          metadata.author === undefined
        ) {
          const author = collapse(attribute(child, "content") ?? "");
          if (author !== "") metadata.author = author;
        }
      }
    };

    const root = document.childNodes.find(
      (n): n is Element => isElement(n) && n.tagName === "html",
    );
    if (root) {
      countAddresses(root);
      for (const child of root.childNodes) {
        if (!isElement(child)) continue;
        if (child.tagName === "body") walk(child, "body", false, "body");
        else walk(child, "", false, "");
      }
    }

    const limitations: Limitation[] = [];
    if (removed > 0) limitations.push({ code: "html.elements-removed", count: removed });
    if (external > 0)
      limitations.push({ code: "html.external-references-ignored", count: external });
    return { ok: true, value: builder.finish({ metadata, limitations }) };
  },
};
