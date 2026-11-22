// The knowledge-schema list (S02-R25): the catalogue of `@pki/contracts` read against the stored type
// definitions. For every name: where it is kept, whether it can be used now, and whether the stored rule
// is the catalogue's. Pure: the caller passes the definitions it may show (the read gate's judgement).
import { KNOWLEDGE_SCHEMA, type CatalogueEntry, type KnowledgePlace } from "@pki/contracts";
import {
  canonicalRule,
  squash,
  type ElementKind,
  type ElementRule,
  type StoredElement,
} from "./ontology.ts";

export interface KnowledgeSchemaEntry {
  category: "knowledge-type" | "relation-type" | "fact-kind";
  name: string;
  place: KnowledgePlace;
  /** A `verified` definition exists; null for a name that has no type definition. */
  usable: boolean | null;
  /** The stored rule is the catalogue's; null for a name that has no type definition, false when none is stored. */
  ruleMatches: boolean | null;
}
export interface KnowledgeSchemaList {
  edition: number;
  entries: KnowledgeSchemaEntry[];
}

const GROUPS = [
  ["knowledgeTypes", "knowledge-type", "item-type"],
  ["relationTypes", "relation-type", "relation-type"],
  ["factKinds", "fact-kind", "fact-kind"],
] as const;

export function describeKnowledgeSchema(
  elements: readonly Pick<StoredElement, "elementKind" | "name" | "rule" | "status">[],
): KnowledgeSchemaList {
  const find = (kind: ElementKind, name: string) =>
    elements.find((e) => e.elementKind === kind && squash(e.name) === squash(name));
  const entry = (
    category: KnowledgeSchemaEntry["category"],
    kind: ElementKind,
    e: CatalogueEntry,
  ): KnowledgeSchemaEntry => {
    if (e.place !== "type-definition" || e.rule === null) {
      return { category, name: e.name, place: e.place, usable: null, ruleMatches: null };
    }
    const stored = find(kind, e.name);
    return {
      category,
      name: e.name,
      place: e.place,
      usable: stored?.status === "verified",
      ruleMatches:
        stored !== undefined &&
        JSON.stringify(canonicalRule(stored.rule)) ===
          JSON.stringify(canonicalRule(e.rule as ElementRule)),
    };
  };
  return {
    edition: KNOWLEDGE_SCHEMA.edition,
    entries: GROUPS.flatMap(([key, category, kind]) =>
      KNOWLEDGE_SCHEMA[key].map((e) => entry(category, kind, e)),
    ),
  };
}
