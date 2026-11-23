// Test-build-only preload for the Ask screen's browser E2E (X01-C2c): `node --import <this file> dev.ts`.
// Whoever imports composition.ts from here on gets the product module with `productProviders` taken from
// x01-ask-double.e2e.ts. The product module is loaded once, under a query, so none of its state is doubled.
import { registerHooks } from "node:module";

const composition = new URL("./composition.ts", import.meta.url).href;
const double = new URL("./x01-ask-double.e2e.ts", import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (url !== composition) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: [
        `export * from ${JSON.stringify(`${composition}?product`)};`,
        `export { productProviders } from ${JSON.stringify(double)};`,
      ].join("\n"),
    };
  },
});
process.stderr.write("PKI E2E: Ask Provider double bound (kind test-double)\n");
