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

export async function openOoxml(
  bytes: Uint8Array,
  limits: Limits,
  bodyEntry: string,
): Promise<{ ok: true; pkg: OoxmlPackage } | { ok: false; error: NormalizeError }> {
  const guarded = await guardZip(bytes, limits.zip);
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
