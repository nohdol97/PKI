// Markdown to text blocks (I02A-R6, R15). CommonMark only (no GFM); raw HTML is
// kept as literal text and never interpreted; link and image addresses are dropped.
import { fromMarkdown } from "mdast-util-from-markdown";
import type { PhrasingContent, RootContent } from "mdast";
import { TextBuilder } from "../text-builder.ts";
import type { Limitation, Locator, TextFormatModule } from "../types.ts";

export const markdownModule: TextFormatModule = {
  format: "markdown",
  input: "text",
  parse(text) {
    const tree = fromMarkdown(text);
    const builder = new TextBuilder();
    let rawHtml = false;
    let dropped = 0;

    const inline = (nodes: PhrasingContent[]): string => {
      let out = "";
      for (const node of nodes) {
        switch (node.type) {
          case "text":
          case "inlineCode":
            out += node.value;
            break;
          case "html":
            rawHtml = true;
            out += node.value;
            break;
          case "break":
            out += "\n";
            break;
          case "image":
            dropped++;
            out += node.alt ?? "";
            break;
          case "imageReference":
            dropped++;
            out += node.alt ?? "";
            break;
          case "link":
          case "linkReference":
            dropped++;
            out += inline(node.children);
            break;
          default:
            if ("children" in node) out += inline(node.children as PhrasingContent[]);
        }
      }
      return out;
    };

    const block = (node: RootContent): void => {
      const line = node.position?.start.line ?? 1;
      let content: string;
      let locator: Locator;
      switch (node.type) {
        case "heading":
          content = inline(node.children);
          locator = { format: "markdown", line, node: "heading", depth: node.depth };
          break;
        case "paragraph":
          content = inline(node.children);
          locator = { format: "markdown", line, node: "paragraph" };
          break;
        case "code":
          content = node.value;
          locator = { format: "markdown", line, node: "code" };
          break;
        case "html":
          rawHtml = true;
          content = node.value;
          locator = { format: "markdown", line, node: "html" };
          break;
        default:
          if ("children" in node) for (const child of node.children as RootContent[]) block(child);
          return;
      }
      builder.block(content, locator);
    };

    for (const node of tree.children) block(node);

    const limitations: Limitation[] = [];
    if (rawHtml) limitations.push({ code: "markdown.raw-html-as-text" });
    if (dropped > 0)
      limitations.push({ code: "markdown.external-references-ignored", count: dropped });
    return { ok: true, value: builder.finish({ limitations }) };
  },
};
