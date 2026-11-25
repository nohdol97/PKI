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

/**
 * The Provider key names: what a Provider host change prunes (`deleteOthers`) and
 * the only kind a prune may keep. Connector credentials are not among them (I06-R4).
 */
export function isBackendReadableSecret(name: string): boolean {
  return BACKEND_READABLE.test(name);
}

/**
 * A Connector credential's stored name: `connector.<32 hex>.<slot>` (I06-R3). The hex
 * is the first 32 digits of the SHA-256 of kind, a newline and instance ID
 * (`@pki/backend` `connectorCredentialName`); the slot is a lower-case word of 1-16
 * characters. The shell reads and checks these for the backend besides Provider
 * keys, but never prunes them.
 */
const CONNECTOR_CREDENTIAL = /^connector\.[0-9a-f]{32}\.[a-z][a-z0-9-]{0,15}$/;

export function isConnectorCredentialSecret(name: string): boolean {
  return CONNECTOR_CREDENTIAL.test(name);
}

/**
 * Provisional (I06-R11, R12), one place: the shortest gap between two notice-driven rebuilds of a
 * rejected instance. The backend holds the notice back by it; the screen reads the list again after it.
 */
export const CREDENTIAL_RETRY_MIN_MS = 30_000;

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
  /**
   * Stores `value` under a Connector credential name (I06S-R8): "done" when stored, "unavailable" when the
   * store refuses the name or cannot be used. Absent on a source that cannot store.
   */
  write?(name: string, value: string): Promise<"done" | "unavailable">;
}

/** What the preload's secret functions answer the page; no answer carries a value. */
export type SecretWriteResult = { ok: true } | { ok: false; error: "unavailable" };
export type SecretPresenceResult =
  { ok: true; present: boolean } | { ok: false; error: "unavailable" };

/** Provisional (I06S-R5), one place: how long a login window may stay open before it ends `timeout`. */
export const LOGIN_TIMEOUT_MS = 300_000;

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;

/** An https address, or an http one on the loopback (`127.0.0.1`, `localhost`) (I06S-R1). */
function loginUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

/**
 * What a fork's registration says about one interactive login (I06S-R1): the session slot, the page to
 * open, the address prefix that means "logged in", and the 1-8 cookies that make up the session.
 */
export const LoginDescriptionSchema = z.strictObject({
  slot: z.string(),
  startUrl: z.string().refine(loginUrl),
  doneUrlPrefix: z.string().refine(loginUrl),
  cookies: z
    .array(z.string().regex(COOKIE_NAME))
    .min(1)
    .max(8)
    .refine((names) => new Set(names).size === names.length),
});
export type LoginDescription = z.infer<typeof LoginDescriptionSchema>;

/** What the shell gets from the backend to open a login (I06S-R3): the description without its slot, and the stored name. */
export const LoginSettingsSchema = LoginDescriptionSchema.omit({ slot: true }).extend({
  name: SecretNameSchema,
});
export type LoginSettings = z.infer<typeof LoginSettingsSchema>;

/** Why a login ended without storing a session (I06S-R5). */
export const LOGIN_ERRORS = [
  "cancelled",
  "timeout",
  "no-session",
  "too-large",
  "store-unavailable",
  "invalid",
  "busy",
] as const;
export type LoginError = (typeof LOGIN_ERRORS)[number];
export type LoginResult = { ok: true } | { ok: false; error: LoginError };
