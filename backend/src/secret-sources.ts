// The backend's secret sources (V01-R4, R13, ADR 0010). The backend keeps no secret:
// a Provider asks its source just before each call. In Electron the shell holds the
// store and answers over the parent channel; the browser development entry (dev.ts,
// not in the product build) reads an environment variable instead; anything else
// has no store and answers "unavailable".
import {
  SecretNameSchema,
  SecretReadSchema,
  SecretValueSchema,
  type SecretRead,
  type SecretSource,
} from "@pki/contracts";

const UNAVAILABLE: SecretRead = Object.freeze({ state: "unavailable" });

export const NO_SECRET_STORE: SecretSource = Object.freeze({ read: async () => UNAVAILABLE });

/**
 * Asks the shell for a secret (`{type: "secret-request", id, name}`) and takes its
 * answer (`{type: "secret", id, ...SecretRead}`). No answer in time is "unavailable";
 * a late answer is dropped.
 */
export function channelSecrets(post: (message: unknown) => void, timeoutMs = 10_000) {
  const pending = new Map<number, (read: SecretRead) => void>();
  let next = 1;

  const source: SecretSource = {
    read(name) {
      if (!SecretNameSchema.safeParse(name).success) return Promise.resolve(UNAVAILABLE);
      const id = next++;
      return new Promise<SecretRead>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(UNAVAILABLE);
        }, timeoutMs);
        pending.set(id, (read) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(read);
        });
        post({ type: "secret-request", id, name });
      });
    },
  };

  /** True when `message` was the answer to a pending request (and is consumed). */
  function deliver(message: unknown): boolean {
    if (typeof message !== "object" || message === null) return false;
    // the envelope, then exactly a SecretRead
    const { type, id, ...rest } = message as Record<string, unknown>;
    if (type !== "secret" || typeof id !== "number") return false;
    const settle = pending.get(id);
    const read = SecretReadSchema.safeParse(rest);
    if (!settle || !read.success) return false;
    settle(read.data);
    return true;
  }

  return { source, deliver };
}

/** `openai-compatible.api-key` → `PKI_DEV_SECRET_OPENAI_COMPATIBLE_API_KEY`. */
export function devSecretVariable(name: string): string {
  return `PKI_DEV_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Development only: the browser has no shell, so the key comes from the environment. */
export function envSecrets(env: Readonly<Record<string, string | undefined>>): SecretSource {
  return {
    async read(name) {
      if (!SecretNameSchema.safeParse(name).success) return UNAVAILABLE;
      const value = env[devSecretVariable(name)];
      if (value === undefined || value === "") return { state: "missing" };
      return SecretValueSchema.safeParse(value).success ? { state: "present", value } : UNAVAILABLE;
    },
  };
}
