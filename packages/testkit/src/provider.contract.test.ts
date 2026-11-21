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

// A Provider without structured output still passes; the structured legs are skipped.
const plainOnly = { structuredOutput: false };
providerContract(
  "fake without structured output",
  () => new FakeProvider({ capabilities: plainOnly }),
  {
    modelCalls: (provider) => provider.requests.length,
    failing: () =>
      new FakeProvider({
        capabilities: plainOnly,
        script: [{ error: new ProviderError("backend failed", { retryable: false }) }],
      }),
  },
);
