// The backend's secret sources (V01-R4, R13, ADR 0010). The backend keeps no secret:
// a Provider reads its key just before each call and checks only presence otherwise.
// In Electron the shell holds the store and answers over the parent channel; the
// browser development entry (dev.ts, not in the product build) reads environment
// variables instead; anything else has no store and answers "unavailable".
import {
  SecretNameSchema,
  SecretReadSchema,
  SecretValueSchema,
  type SecretPresence,
  type SecretRead,
  type SecretSource,
} from "@pki/contracts";
import { openaiKeySecretName } from "@pki/providers";

const UNAVAILABLE: SecretRead = Object.freeze({ state: "unavailable" });

export const NO_SECRET_STORE: SecretSource = Object.freeze({
  read: async () => UNAVAILABLE,
  has: async () => "unavailable" as const,
  // nothing is stored, so nothing is left to delete
  deleteOthers: async () => "done" as const,
});

type Mode = "read" | "presence" | "prune";
type Answer = SecretRead | { state: "present" };
const PRESENCES: readonly unknown[] = ["present", "missing", "unavailable"];

/** A read answer is exactly a SecretRead; a presence answer is a bare state, no value. */
function parseAnswer(mode: Mode, rest: Record<string, unknown>): Answer | undefined {
  if (mode === "read") return SecretReadSchema.safeParse(rest).data;
  const states = mode === "prune" ? ["missing", "unavailable"] : PRESENCES;
  const only = Object.keys(rest).length === 1 && states.includes(rest.state);
  return only ? ({ state: rest.state } as Answer) : undefined;
}

/**
 * Asks the shell (`{type: "secret-request", id, name, mode}`) and takes its answer
 * (`{type: "secret", id, ...}`). No answer in time is "unavailable"; a late or
 * malformed answer is dropped.
 */
export function channelSecrets(post: (message: unknown) => void, timeoutMs = 10_000) {
  const pending = new Map<number, { mode: Mode; settle: (answer: Answer) => void }>();
  let next = 1;

  function ask(name: string, mode: Mode): Promise<Answer> {
    if (!SecretNameSchema.safeParse(name).success) return Promise.resolve(UNAVAILABLE);
    const id = next++;
    return new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(UNAVAILABLE);
      }, timeoutMs);
      pending.set(id, {
        mode,
        settle: (answer) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(answer);
        },
      });
      post({ type: "secret-request", id, name, mode });
    });
  }

  const source: SecretSource = {
    read: (name) => ask(name, "read") as Promise<SecretRead>,
    has: async (name): Promise<SecretPresence> => (await ask(name, "presence")).state,
    deleteOthers: async (keep) =>
      (await ask(keep, "prune")).state === "missing" ? "done" : "unavailable",
  };

  /** True when `message` was the answer to a pending request (and is consumed). */
  function deliver(message: unknown): boolean {
    if (typeof message !== "object" || message === null) return false;
    const { type, id, ...rest } = message as Record<string, unknown>;
    if (type !== "secret" || typeof id !== "number") return false;
    const waiting = pending.get(id);
    const answer = waiting && parseAnswer(waiting.mode, rest);
    if (!waiting || !answer) return false;
    waiting.settle(answer);
    return true;
  }

  return { source, deliver };
}

/** The development entry's variables: the key, and the endpoint host it is for. */
export const DEV_KEY_VARIABLE = "PKI_DEV_OPENAI_API_KEY";
export const DEV_KEY_HOST_VARIABLE = "PKI_DEV_OPENAI_API_KEY_HOST";

/**
 * Development only: the browser has no shell, so the OpenAI-compatible key comes from
 * the environment, bound like a stored one to the host it names (e.g.
 * `api.example.com` or `127.0.0.1:8080`). Read at call time, never stored.
 */
export function envSecrets(env: Readonly<Record<string, string | undefined>>): SecretSource {
  function lookup(name: string): SecretRead {
    const host = env[DEV_KEY_HOST_VARIABLE];
    const value = env[DEV_KEY_VARIABLE];
    if (!host || !URL.canParse(`https://${host}`)) return { state: "missing" };
    if (name !== openaiKeySecretName(new URL(`https://${host}`).host)) return { state: "missing" };
    if (value === undefined || value === "") return { state: "missing" };
    return SecretValueSchema.safeParse(value).success ? { state: "present", value } : UNAVAILABLE;
  }
  return {
    read: async (name) => lookup(name),
    has: async (name) => lookup(name).state,
    deleteOthers: async () => "done", // the environment holds the one key it names
  };
}
