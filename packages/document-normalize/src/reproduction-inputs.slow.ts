// I02B-C17 (I02B-R25): the two reproduction inputs of the I02-A review, rebuilt by `testing/time-bombs.ts`,
// go through the isolated normalizer with the default limits (60 s, 1,536 MB heap, 1.5 GiB outside the
// heap) and each comes back as `timed-out` or `resource-exceeded` within the time limit plus 1 s. An input
// that is normalized before the limit is too weak to reproduce the review's time, and the test fails for
// that (a weak input is not read as a pass). Not a `.test.ts`: each run holds the 60 s limit. See
// vitest.normalizer-slow.config.ts.
import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedNormalizer, type IsolatedNormalizer } from "./isolated.ts";
import { createForkSpawner } from "./spawn-node.ts";
import { makePdfBomb, makeSlowMarkdown } from "./testing/time-bombs.ts";

const TIMEOUT_MS = 60_000;
/** The review's 24 KB Markdown took 14 s; this input is bigger (the time grows with the square of the units). */
const MARKDOWN_UNITS = 30_000;

let normalizer: IsolatedNormalizer | undefined;
afterEach(async () => {
  await normalizer?.close();
  normalizer = undefined;
});

async function warm() {
  normalizer = createIsolatedNormalizer({
    spawner: createForkSpawner(),
    timeoutMs: TIMEOUT_MS,
    maxHeapMb: 1_536,
    maxExternalMemoryBytes: 1_610_612_736,
  });
  // a host that is up: the clock below is the job's
  const small = await normalizer.normalize({
    bytes: new TextEncoder().encode("# warm\n"),
    name: "warm.md",
  });
  expect(small.ok).toBe(true);
  return normalizer;
}

async function limited(bytes: Uint8Array, name: string) {
  const n = await warm();
  const started = performance.now();
  const result = await n.normalize({ bytes, name });
  const seconds = (performance.now() - started) / 1000;
  const line = `C17 ${name}: ${bytes.length} bytes -> ${result.ok ? "normalized" : result.error.code} in ${seconds.toFixed(1)} s at ${new Date().toISOString()}`;
  console.log(line);
  // the console of a passing test is not kept: when set, the line goes to this file too
  if (process.env.PKI_SLOW_LOG !== undefined) appendFileSync(process.env.PKI_SLOW_LOG, `${line}\n`);
  return { result, seconds };
}

describe("I02B-C17: the reproduction inputs end at the limit", () => {
  it("the slow Markdown", async () => {
    const { result, seconds } = await limited(makeSlowMarkdown(MARKDOWN_UNITS), "slow.md");
    expect(result.ok, "the input finished before the limit: too weak to reproduce").toBe(false);
    expect(["timed-out", "resource-exceeded"]).toContain(!result.ok && result.error.code);
    expect(seconds).toBeLessThanOrEqual(TIMEOUT_MS / 1000 + 1);
  });

  it("the PDF bomb", async () => {
    const { result, seconds } = await limited(await makePdfBomb(), "bomb.pdf");
    expect(result.ok, "the input finished before the limit: too weak to reproduce").toBe(false);
    expect(["timed-out", "resource-exceeded"]).toContain(!result.ok && result.error.code);
    expect(seconds).toBeLessThanOrEqual(TIMEOUT_MS / 1000 + 1);
  });
});
