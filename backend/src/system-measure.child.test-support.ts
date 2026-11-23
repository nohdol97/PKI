// The backend H03-C2's measurement runner starts (system-measure.main.test-support.ts): the real bootBackend on the
// data directory in PKI_MEASURE_DATA_DIR with the stub Provider (D6: one quoted knowledge line per document, answered
// after PKI_MEASURE_DELAY_MS), bound under the id `local-model`. Run by `node` as a source run, or by vitest
// (vitest.system-measure.config.ts) as a test build whose job lease is PKI_MEASURE_LEASE_MS. It writes
// `{url, token}` as one line to stdout and to the file PKI_MEASURE_READY, then runs until killed.
import { FakeProvider } from "@pki/testkit";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { bootBackend } from "./boot.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import { STUB_PROVIDER_ID, stubExtraction } from "./system-measure.test-support.ts";

const setting = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
};

async function run(): Promise<never> {
  const token = randomBytes(32).toString("base64url");
  const leaseMs = process.env.PKI_MEASURE_LEASE_MS;
  const { server } = await bootBackend({
    dataDir: setting("PKI_MEASURE_DATA_DIR"),
    token,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [
      new FakeProvider({
        id: STUB_PROVIDER_ID,
        transport: "http",
        delayMs: Number(setting("PKI_MEASURE_DELAY_MS")),
        answer: stubExtraction,
      }),
    ],
    // a test build only: the product's lease is the source run's
    ...(leaseMs === undefined ? {} : { testBuild: { jobs: { leaseMs: Number(leaseMs) } } }),
  });
  const ready = JSON.stringify({ url: server.url, token });
  writeFileSync(setting("PKI_MEASURE_READY"), ready);
  process.stdout.write(`${ready}\n`);
  return new Promise<never>(() => {});
}

if (process.env.VITEST === undefined) {
  await run();
} else {
  const { it } = await import("vitest");
  it("runs the backend until killed", run, 2_147_483_647);
}
