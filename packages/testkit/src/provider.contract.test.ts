// Runs `provider.contract` against the fake Provider (test builds only).
import { FakeProvider } from "./fake-provider.ts";
import { providerContract } from "./provider.contract.ts";

providerContract("fake", () => new FakeProvider());
