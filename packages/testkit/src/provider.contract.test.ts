// Runs `provider.contract` against the fake Provider (test builds only).
import { ProviderError } from "@pki/contracts";
import { FakeProvider } from "./fake-provider.ts";
import { providerContract } from "./provider.contract.ts";

providerContract("fake", () => new FakeProvider(), {
  modelCalls: (provider) => provider.requests.length,
  failing: () =>
    new FakeProvider({
      script: [{ error: new ProviderError("backend failed", { retryable: true }) }],
    }),
});
