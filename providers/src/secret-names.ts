// Host-bound secret names (V01-T11, review A-F3/B-B1). The OpenAI-compatible key is
// stored under a name derived from the endpoint host it was entered for. Pointing
// the endpoint at another host (a compromised page can do that, and grant consent
// for it) finds no key under the new name, so nothing is sent there until the user
// enters the key again; the page itself never holds the value it would need.
import { OPENAI_API_KEY_SECRET_PREFIX } from "@pki/contracts";
import { createHash } from "node:crypto";

/** `host` as `URL.host` gives it (lower-case, punycode, default port dropped). */
export function openaiKeySecretName(host: string): string {
  return (
    OPENAI_API_KEY_SECRET_PREFIX + createHash("sha256").update(host).digest("hex").slice(0, 32)
  );
}
