// I05-T03 `site.public-kinds` (I05-R7, R8, I05-C14 ①): the public kinds and the public instance ids
// come from one module, and every kind or id the public composition points use is in it. A public
// change that adds a kind or an instance without touching the module fails here.
import { JSONL_IMPORT_KIND } from "@pki/connector-sdk";
import { SYNTHETIC_CONNECTOR_KIND_LIST } from "@pki/providers";
import { describe, expect, it } from "vitest";
import { fixtureConnectors, productConnectors } from "./composition.ts";
import { readFileSync } from "node:fs";
import {
  isPublicInstanceId,
  PUBLIC_CONNECTOR_KINDS,
  PUBLIC_INSTANCE_ID_PREFIXES,
  SITE_CONNECTOR_KINDS,
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

  it("local-files is a public kind and its one instance a public id, in the product's one list (I02B-C43)", () => {
    expect(PUBLIC_CONNECTOR_KINDS).toContain("local-files");
    expect(isPublicInstanceId("local-files")).toBe(true);
    expect(Object.keys(productConnectors().kinds)).toContain("local-files");
  });

  it("the kind the import writes to the canonical DB", () => {
    expect(PUBLIC_CONNECTOR_KINDS).toContain(JSONL_IMPORT_KIND);
  });

  it("every kind the Broker trusts as synthetic", () => {
    expect(SYNTHETIC_CONNECTOR_KIND_LIST.length).toBeGreaterThan(0);
    for (const kind of SYNTHETIC_CONNECTOR_KIND_LIST)
      expect(PUBLIC_CONNECTOR_KINDS).toContain(kind);
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

describe("site.public-kinds: the module is a leaf (security review F3)", () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

  it("imports nothing from the composition root or an adapter, so a module the root imports can import it", () => {
    expect(source("./public-kinds.ts")).not.toMatch(/from "\.\/(composition|adapters\/)/);
  });

  it("is where the placeholder kinds are defined, and the composition root re-exports nothing of them", () => {
    expect(source("./public-kinds.ts")).toContain("export const SITE_CONNECTOR_KINDS");
    expect(source("./composition.ts")).not.toMatch(/export \{ SITE_CONNECTOR_KINDS/);
    expect(source("./adapters/site-connectors.ts")).not.toContain(
      "export const SITE_CONNECTOR_KINDS",
    );
  });
});
