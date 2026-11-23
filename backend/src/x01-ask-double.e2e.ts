// Test-build-only Provider binding for the Ask screen's browser E2E (X01-C2c): `node --import
// x01-ask.hook.e2e.ts dev.ts` makes this module's `productProviders` stand in for the composition point's, as
// v02-double.e2e.ts does for the extraction flow. The Provider cites each document it is given whole, which
// the product's check then finds exactly once. On first start it records consent for `local-model` with the
// `general` class and `local-model` as the default Provider, as the user would in Settings. No product
// process gains a switch; the `.e2e.ts` name keeps this a test module that no installer carries.
import type { LLMProvider } from "@pki/contracts";
import { DEFAULT_PROVIDER_SETTING, readDefaultProvider, type EgressControls } from "@pki/providers";
import { writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider } from "@pki/testkit";

const DOUBLE_ID = "local-model";

function consentLocalModel(egress: EgressControls): void {
  const shown = egress.overview().providers.find((p) => p.providerId === DOUBLE_ID);
  const granted = egress.grant(DOUBLE_ID, ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

export function providerDouble(): FakeProvider {
  return new FakeProvider({
    id: DOUBLE_ID,
    transport: "http",
    answer: (request) => ({
      sentences: request.input.untrustedDocuments.map((d) => ({
        text: "답 문장",
        documentId: d.id,
        quote: d.body,
      })),
      insufficient: false,
    }),
  });
}

/** Stands in for composition.ts `productProviders` (same parameters; CLI runs unused). */
export function productProviders(
  db: SqlDriver,
  _secrets: unknown,
  egress: EgressControls,
): readonly LLMProvider[] {
  const shown = egress.overview().providers.find((p) => p.providerId === DOUBLE_ID);
  if (!shown?.consent) consentLocalModel(egress);
  if (readDefaultProvider(db) === undefined) writeSetting(db, DEFAULT_PROVIDER_SETTING, DOUBLE_ID);
  return [providerDouble()];
}
