// I01-C4 `connectors.public-only` ① (I01-R28): the product's Connector kinds are
// exactly jsonl-import and the three site kinds. Read from the product
// composition itself: the kinds it registers (productConnectors) and the kind its
// importer leaves in the canonical DB after a real import of one synthetic line.
// The import allow-list and the site/ placeholders are in
// tooling/connectors/public-only.test.ts (I01 spec "T09가 넘기는 것").
import { CONNECTOR_NOT_IMPLEMENTED } from "@pki/contracts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { openCanonicalDb, productConnectors, productImporter } from "./composition.ts";

const SYNTHETIC_LINE = readFileSync(
  resolve(import.meta.dirname, "../../fixtures/v02-mail.jsonl"),
  "utf8",
);
const SITE_KINDS = ["site-mail", "site-messenger", "site-wiki"];

it("the product's Connector kinds are exactly jsonl-import and the three site kinds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pki-public-only-"));
  const db = openCanonicalDb(join(dir, "data"));
  try {
    const product = productConnectors();
    const registered = Object.keys(product.kinds);
    expect([...registered].sort()).toEqual(SITE_KINDS);
    // every instance the product starts with is of a registered site kind
    expect(product.instances.map((i) => i.kind).sort()).toEqual(SITE_KINDS);

    expect(await productImporter(db)(SYNTHETIC_LINE)).toMatchObject({ created: 1, errors: [] });
    const imported = db
      .all("SELECT DISTINCT kind FROM connector_instances")
      .map((row) => row.kind as string);
    expect(imported).toEqual(["jsonl-import"]);

    expect([...new Set([...registered, ...imported])].sort()).toEqual([
      "jsonl-import",
      "site-mail",
      "site-messenger",
      "site-wiki",
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(SITE_KINDS)("%s fails to initialize with the follow-up notice", async (kind) => {
  const factory = productConnectors().kinds[kind];
  expect(factory).toBeDefined();
  await expect(factory?.().initialize({})).rejects.toThrow(CONNECTOR_NOT_IMPLEMENTED);
});
