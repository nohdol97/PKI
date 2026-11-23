// Test support (not product code): the real parser called in-process, as the connector's normalizer port,
// and one whose host is broken. The product reaches the parser only through the isolated host (I02B-C18).
import type { LocalNormalizerPort, LocalNormalizeResult } from "@pki/contracts";
import { normalizeDocument } from "@pki/document-normalize";

export function inProcessNormalizer(broken = false): LocalNormalizerPort {
  return {
    async normalize(input, opts) {
      if (broken) return { ok: false, error: { code: "worker-failed" }, unavailable: true };
      const result = await normalizeDocument(
        { kind: "bytes", bytes: input.bytes, name: input.name },
        opts.limits ? { limits: opts.limits } : {},
      );
      return result as unknown as LocalNormalizeResult;
    },
    unavailable: () => broken,
    recheck: async () => !broken,
  };
}
