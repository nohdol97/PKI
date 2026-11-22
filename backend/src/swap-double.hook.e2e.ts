// Test-build-only preload (V01-T17): `node --import <this file> dev.ts`, the browser
// E2E's swapped configuration (apps/web/e2e/screens.e2e.ts). From here on, whoever
// imports composition.ts gets the product module with `productProviders` and
// `productAdapters` taken from swap-double.e2e.ts. The product module itself is
// loaded once, under a query, so none of its state is doubled. A run that binds the
// doubles says so on stderr, once per process.
import { registerHooks } from "node:module";

const composition = new URL("./composition.ts", import.meta.url).href;
const double = new URL("./swap-double.e2e.ts", import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (url !== composition) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: [
        `export * from ${JSON.stringify(`${composition}?product`)};`,
        `export { productProviders, productAdapters } from ${JSON.stringify(double)};`,
      ].join("\n"),
    };
  },
});
process.stderr.write("PKI E2E: Provider and Embedding doubles bound (swapped configuration)\n");
