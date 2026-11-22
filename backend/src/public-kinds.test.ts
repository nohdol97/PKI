// I05-T03 `site.public-kinds` (I05-R7, R8, I05-C14 ①): the public kinds and the public instance ids
// come from one module, and every kind or id the public composition points use is in it. A public
// change that adds a kind or an instance without touching the module fails here.
import { JSONL_IMPORT_KIND } from "@pki/connector-sdk";
import { SYNTHETIC_CONNECTOR_KINDS } from "@pki/providers";
import { describe, expect, it } from "vitest";
import { SITE_CONNECTOR_KINDS } from "./adapters/site-connectors.ts";
import { fixtureConnectors, productConnectors } from "./composition.ts";
import {
  isPublicInstanceId,
  PUBLIC_CONNECTOR_KINDS,
  PUBLIC_INSTANCE_ID_PREFIXES,
} from "./public-kinds.ts";

const isPlaceholder = (name: string) => (SITE_CONNECTOR_KINDS as readonly string[]).includes(name);
const sets = [
  ["productConnectors()", productConnectors()],
  ["fixtureConnectors()", fixtureConnectors("/synthetic/f.jsonl")],
] as const;

describe("site.public-kinds: the kinds the public code uses are all in PUBLIC_CONNECTOR_KINDS", () => {
  it.each(sets)("every kind %s registers that is not a placeholder", (_name, set) => {
    for (const kind of Object.keys(set.kinds).filter((k) => !isPlaceholder(k))) {
      expect(PUBLIC_CONNECTOR_KINDS, kind).toContain(kind);
    }
  });

  it("the kind the import writes to the canonical DB", () => {
    expect(PUBLIC_CONNECTOR_KINDS).toContain(JSONL_IMPORT_KIND);
  });

  it("every kind the Broker trusts as synthetic", () => {
    expect([...SYNTHETIC_CONNECTOR_KINDS].length).toBeGreaterThan(0);
    for (const kind of SYNTHETIC_CONNECTOR_KINDS) expect(PUBLIC_CONNECTOR_KINDS).toContain(kind);
  });

  it("holds no placeholder: a fork may replace those", () => {
    for (const kind of PUBLIC_CONNECTOR_KINDS) expect(isPlaceholder(kind), kind).toBe(false);
  });
});

describe("site.public-kinds: the public instance ids are answered by isPublicInstanceId", () => {
  it.each(sets)("every id %s starts with that is not a placeholder's", (_name, set) => {
    for (const { id } of set.instances.filter((i) => !isPlaceholder(i.id))) {
      expect(isPublicInstanceId(id), id).toBe(true);
    }
  });

  it("a placeholder's id is public until a registration replaces that placeholder kind", () => {
    for (const id of SITE_CONNECTOR_KINDS) {
      expect(isPublicInstanceId(id)).toBe(true);
      expect(isPublicInstanceId(id, new Set())).toBe(true);
      expect(isPublicInstanceId(id, new Set([id]))).toBe(false);
    }
    // replacing one placeholder does not free another's id
    expect(isPublicInstanceId("site-wiki", new Set(["site-mail"]))).toBe(true);
  });

  it("an id of no one's is not public", () => {
    expect(isPublicInstanceId("my-own-1")).toBe(false);
    expect(isPublicInstanceId("")).toBe(false);
  });

  it("an id that begins with a reserved prefix is public (the list is empty until a public kind reserves one)", () => {
    for (const prefix of PUBLIC_INSTANCE_ID_PREFIXES) {
      expect(isPublicInstanceId(`${prefix}anything`), prefix).toBe(true);
    }
    expect(isPublicInstanceId("jsonl-file:abc", new Set(), ["jsonl-file:"])).toBe(true);
    expect(isPublicInstanceId("jsonl-fil", new Set(), ["jsonl-file:"])).toBe(false);
    expect(isPublicInstanceId("xjsonl-file:abc", new Set(), ["jsonl-file:"])).toBe(false);
  });
});
