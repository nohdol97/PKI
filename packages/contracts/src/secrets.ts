// Secret values (V01-R13, ADR 0010). The Electron shell keeps them (OS-protected
// encryption); the backend asks for one just before a call that needs it; the
// page may store, check and delete one but never read it back.
import { z } from "zod";

export const SecretNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const SecretValueSchema = z.string().min(1).max(8192);

/** The OpenAI-compatible Provider's API key. */
export const OPENAI_API_KEY_SECRET = "openai-compatible.api-key";

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

/** Where a Provider reads its secret, every time it is about to send. */
export interface SecretSource {
  read(name: string): Promise<SecretRead>;
}

/** What the preload's secret functions answer the page; no answer carries a value. */
export type SecretWriteResult = { ok: true } | { ok: false; error: "unavailable" };
export type SecretPresenceResult =
  { ok: true; present: boolean } | { ok: false; error: "unavailable" };
