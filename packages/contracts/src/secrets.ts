// Secret values (V01-R13, ADR 0010). The Electron shell keeps them (OS-protected
// encryption); the backend asks for one just before a call that needs it; the
// page may store, check and delete one but never read it back.
import { z } from "zod";

export const SecretNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const SecretValueSchema = z.string().min(1).max(8192);

/**
 * The OpenAI-compatible Provider's API key is stored per endpoint host: its name is
 * this prefix and the first 32 hex digits of the host's SHA-256 (`@pki/providers`
 * `openaiKeySecretName`). A key saved for one host is never sent to another, so a
 * changed endpoint needs the key entered again (V01-T11, review A-F3/B-B1).
 */
export const OPENAI_API_KEY_SECRET_PREFIX = "openai-compatible.api-key.";
const BACKEND_READABLE = /^openai-compatible\.api-key\.[0-9a-f]{32}$/;

/** The only secret names the shell gives the backend (others: "unavailable"). */
export function isBackendReadableSecret(name: string): boolean {
  return BACKEND_READABLE.test(name);
}

/**
 * One secret as its store has it. "unavailable": the store cannot be used (no OS
 * protection, unreadable file, failed decryption) — never a reason to fall back
 * to plaintext.
 */
export const SecretReadSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("present"), value: SecretValueSchema }),
  z.strictObject({ state: z.literal("missing") }),
  z.strictObject({ state: z.literal("unavailable") }),
]);
export type SecretRead = z.infer<typeof SecretReadSchema>;

/** Whether a secret is there, without its value. */
export type SecretPresence = SecretRead["state"];

/**
 * Where a Provider gets its secret: `read` only just before it sends, `has` for
 * checks that need presence only (the value does not leave the store for them).
 */
export interface SecretSource {
  read(name: string): Promise<SecretRead>;
  has(name: string): Promise<SecretPresence>;
  /**
   * Deletes every key the backend may read except `keep` (review N1): when the
   * endpoint host changes, earlier hosts' keys go, so pointing back to an old host
   * never silently reuses its key. "done" also when nothing was stored.
   */
  deleteOthers(keep: string): Promise<"done" | "unavailable">;
}

/** What the preload's secret functions answer the page; no answer carries a value. */
export type SecretWriteResult = { ok: true } | { ok: false; error: "unavailable" };
export type SecretPresenceResult =
  { ok: true; present: boolean } | { ok: false; error: "unavailable" };
