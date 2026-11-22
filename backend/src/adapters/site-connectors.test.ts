// I01-H2 `connector.not-implemented`: run through the contract check, each site
// placeholder yields not-implemented instead of violations (I01-R25, R26).
import { checkConnector } from "@pki/testkit";
import { expect, it } from "vitest";
import { createSiteConnector, SITE_CONNECTOR_KINDS } from "./site-connectors.ts";

it.each(SITE_CONNECTOR_KINDS)("%s yields not-implemented from checkConnector", async (kind) => {
  expect(await checkConnector(() => createSiteConnector(kind), { config: {} })).toEqual([
    "not-implemented",
  ]);
});
