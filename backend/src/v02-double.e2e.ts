// Test-build-only Provider binding for a running backend (V02-T11, V02-R17; spec
// "T11이 넘기는 것"). v02-double.hook.e2e.ts, loaded ahead of the backend's own
// entry (`node --import` before dev.ts in the browser E2E; v02-shell.e2e.ts before
// shell.ts in the Electron one), makes this module's `productProviders` stand in for the composition
// point's: the per-fixture Provider double
// (@pki/testkit fixtureExtraction, Provider kind `test-double`), the same binding
// the T10 seed uses. Nothing else of the backend changes: the entries, boot, the
// Broker, the job runner and the screens run as they are. On first start it also
// records what the user would otherwise choose in Settings: consent for
// `local-model` with the `general` class, and `local-model` as the default
// Provider (V01-T10); a restart keeps what the DB already holds.
// It adds no switch to any product process. The `.e2e.ts` name keeps it a test
// module (module boundary; Playwright's testIgnore). T15: it, v02-seed.e2e.ts and
// @pki/testkit never ship in an installer.
import type { LLMProvider } from "@pki/contracts";
import { DEFAULT_PROVIDER_SETTING, readDefaultProvider, type EgressControls } from "@pki/providers";
import { writeSetting, type SqlDriver } from "@pki/storage";
import { FakeProvider, fixtureExtraction } from "@pki/testkit";

/** The Provider id the double answers under (the run record names it: v02-flow.e2e.ts). */
const DOUBLE_ID = "local-model";

/** Grants `local-model` the `general` class at its shown destination. */
export function consentLocalModel(egress: EgressControls): void {
  const shown = egress.overview().providers.find((p) => p.providerId === DOUBLE_ID);
  const granted = egress.grant(DOUBLE_ID, ["general"], {
    destination: shown?.destination ?? "",
    policyVersion: egress.policyVersion(),
  });
  if ("error" in granted) throw new Error(granted.error);
}

/** The per-fixture double, under the id the user's consent and default name. */
export function providerDouble(): FakeProvider {
  return new FakeProvider({
    id: DOUBLE_ID,
    transport: "http",
    answer: fixtureExtraction(),
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
  if (readDefaultProvider(db) === undefined) {
    writeSetting(db, DEFAULT_PROVIDER_SETTING, DOUBLE_ID);
  }
  return [providerDouble()];
}
