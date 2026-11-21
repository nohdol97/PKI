// What DOCX and XLSX share (I02A-R4, R17): open the package through the zip guard,
// require the body part, read docProps/core.xml.
import { DOMParser } from "@xmldom/xmldom";
import { formatFailure } from "./text-builder.ts";
import type { Limits } from "./limits.ts";
import type { DocumentMetadata, NormalizeError } from "./types.ts";
import { guardZip } from "./zip-guard.ts";

export interface OoxmlPackage {
  /** Checked entries by name. */
  entries: Map<string, Uint8Array>;
  /** The archive the parser reads: checked entries only (I02A-R4). */
  rezipped: Uint8Array;
}

/** Parts neither mammoth nor read-excel-file reads here (R6: pictures and objects are omitted). */
const UNREAD_PARTS = /^(?:word|xl)\/(?:media|embeddings)\//;

export async function openOoxml(
  bytes: Uint8Array,
  limits: Limits,
  bodyEntry: string,
): Promise<{ ok: true; pkg: OoxmlPackage } | { ok: false; error: NormalizeError }> {
  const guarded = await guardZip(bytes, limits.zip, (name) => UNREAD_PARTS.test(name));
  if (!guarded.ok) return guarded;
  const entries = new Map(guarded.entries.map((e) => [e.name, e.data]));
  if (!entries.has(bodyEntry)) {
    return formatFailure("format-mismatch", `${bodyEntry} 항목이 없어 이 형식의 문서가 아니다`);
  }
  return { ok: true, pkg: { entries, rezipped: guarded.rezipped } };
}

/** UTF-8 text of an entry, or `""` when it is absent. */
export function entryText(pkg: OoxmlPackage, name: string): string {
  const data = pkg.entries.get(name);
  return data ? new TextDecoder().decode(data) : "";
}

export type XmlToken =
  | { kind: "open"; name: string; attributes: string; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; value: string };

const localName = (qualified: string) => qualified.slice(qualified.indexOf(":") + 1);

/**
 * Index just past the `>` that ends a `<!...` declaration (a DOCTYPE): `>` inside a quoted
 * literal or the `[...]` internal subset does not end it, and comments and processing
 * instructions inside the subset are skipped whole. One pass; unterminated ends at `end`.
 */
function declarationEnd(xml: string, from: number): number {
  const end = xml.length;
  let quote = "";
  let subset = false;
  for (let i = from; i < end; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (subset && c === "<" && xml.startsWith("<!--", i)) {
      const close = xml.indexOf("-->", i + 4);
      if (close === -1) return end;
      i = close + 2;
    } else if (subset && c === "<" && xml.startsWith("<?", i)) {
      const close = xml.indexOf("?>", i + 2);
      if (close === -1) return end;
      i = close + 1;
    } else if (c === "[") subset = true;
    else if (c === "]") subset = false;
    else if (c === ">" && !subset) return i + 1;
  }
  return end;
}

const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the five predefined entities and numeric character references; others stay as written. */
function decodeReferences(value: string): string {
  return value.replace(
    /&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,8})|(amp|lt|gt|quot|apos));/g,
    (whole, hex, dec, name) => {
      if (name) return PREDEFINED[name] as string;
      const code = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

/**
 * Single-pass tag scanner for the limitation checks: every character is visited once,
 * comments, processing instructions and declarations are skipped as a whole, CDATA comes back as text,
 * and `>` inside a quoted attribute value does not end a tag. Element names come back
 * without their prefix. Stops when `visit` returns `true`. No backtracking, so the
 * time is linear in the part size whatever an attacker writes into it.
 */
export function scanXml(xml: string, visit: (token: XmlToken) => boolean): void {
  const end = xml.length;
  let at = 0;
  while (at < end) {
    const lt = xml.indexOf("<", at);
    const textEnd = lt === -1 ? end : lt;
    if (textEnd > at && visit({ kind: "text", value: xml.slice(at, textEnd) })) return;
    if (lt === -1) return;
    let next: number;
    if (xml.startsWith("<!--", lt)) {
      next = xml.indexOf("-->", lt + 4);
      next = next === -1 ? end : next + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const close = xml.indexOf("]]>", lt + 9);
      next = close === -1 ? end : close + 3;
      if (close > lt + 9 && visit({ kind: "text", value: xml.slice(lt + 9, close) })) return;
    } else if (xml.startsWith("<?", lt)) {
      next = xml.indexOf("?>", lt + 2);
      next = next === -1 ? end : next + 2;
    } else if (xml.startsWith("<!", lt)) {
      next = declarationEnd(xml, lt + 2);
    } else {
      let quote = "";
      let i = lt + 1;
      for (; i < end; i++) {
        const c = xml[i];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      next = i + 1;
      if (i < end) {
        const inner = xml.slice(lt + 1, i);
        const closing = inner.startsWith("/");
        const selfClosing = inner.endsWith("/");
        const body = closing ? inner.slice(1) : selfClosing ? inner.slice(0, -1) : inner;
        let n = 0;
        while (n < body.length && !/\s/.test(body[n] as string)) n++;
        const name = localName(body.slice(0, n));
        const token: XmlToken = closing
          ? { kind: "close", name }
          : { kind: "open", name, attributes: body.slice(n), selfClosing };
        if (visit(token)) return;
      }
    }
    at = next;
  }
}

/** Value of the attribute with this local name in a tag's attribute text, or `undefined`. */
export function attributeValue(attributes: string, wanted: string): string | undefined {
  const end = attributes.length;
  let i = 0;
  while (i < end) {
    while (i < end && /\s/.test(attributes[i] as string)) i++;
    const nameStart = i;
    while (i < end && !/[\s=]/.test(attributes[i] as string)) i++;
    const name = attributes.slice(nameStart, i);
    while (i < end && /\s/.test(attributes[i] as string)) i++;
    if (attributes[i] !== "=") continue;
    i++;
    while (i < end && /\s/.test(attributes[i] as string)) i++;
    const quote = attributes[i];
    if (quote !== '"' && quote !== "'") continue;
    const close = attributes.indexOf(quote, i + 1);
    if (close === -1) return undefined;
    if (localName(name) === wanted) return decodeReferences(attributes.slice(i + 1, close));
    i = close + 1;
  }
  return undefined;
}

const silent = { warning() {}, error() {}, fatalError() {} };

/** `title`, `author`, `created`, `modified` from docProps/core.xml; absent or empty fields are left out. */
export function readCoreProperties(pkg: OoxmlPackage): DocumentMetadata {
  const xml = entryText(pkg, "docProps/core.xml");
  if (!xml) return {};
  try {
    const doc = new DOMParser({ errorHandler: silent }).parseFromString(xml, "text/xml");
    const field = (localName: string): string | undefined => {
      const text = doc.getElementsByTagNameNS("*", localName).item(0)?.textContent?.trim();
      return text ? text : undefined;
    };
    const date = (localName: string): string | undefined => {
      const raw = field(localName);
      const time = raw === undefined ? NaN : Date.parse(raw);
      return Number.isNaN(time) ? undefined : new Date(time).toISOString();
    };
    const metadata: DocumentMetadata = {};
    const title = field("title");
    const author = field("creator");
    const created = date("created");
    const modified = date("modified");
    if (title !== undefined) metadata.title = title;
    if (author !== undefined) metadata.author = author;
    if (created !== undefined) metadata.created = created;
    if (modified !== undefined) metadata.modified = modified;
    return metadata;
  } catch {
    return {};
  }
}
