// I01-C4 `connectors.public-only` ① (I01-R28): the product's Connector kinds are
// exactly jsonl-import and the three site kinds. Read from the product
// composition itself: the kinds it registers (productConnectors) and the kind its
// importer leaves in the canonical DB after a real import of one synthetic line.
// The import allow-list and the site/ placeholders are in
// tooling/connectors/public-only.test.ts (I01 spec "T09가 넘기는 것").
import { CONNECTOR_NOT_IMPLEMENTED, routes } from "@pki/contracts";
import { send } from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { openCanonicalDb, productConnectors, productImporter } from "./composition.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { mergeSiteRegistration, publicSite } from "./site-registration.ts";

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

// I05-C14 ②: the empty registration changes nothing of what the product starts with. The
// kinds themselves are not named here: whatever `productConnectors()` gives is what the start lists.
it("a start with the empty registration lists exactly the instances productConnectors() gives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pki-public-only-boot-"));
  const token = "e".repeat(43);
  const booted = await bootBackend({
    dataDir: dir,
    token,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    site: publicSite,
  });
  try {
    const { port } = booted.server;
    const listed = (
      await send(port, routes.connectors.path, {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
      })
    ).body as { connectors: { id: string; kind: string }[] };
    const sorted = (list: { id: string; kind: string }[]) =>
      list.map(({ id, kind }) => ({ id, kind })).sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted(listed.connectors)).toEqual(sorted(productConnectors().instances));
    const merged = mergeSiteRegistration(publicSite, productConnectors());
    expect(merged.violations).toEqual([]);
    expect(Object.keys(merged.connectors.kinds).sort()).toEqual(
      Object.keys(productConnectors().kinds).sort(),
    );
  } finally {
    await booted.server.close();
    booted.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
