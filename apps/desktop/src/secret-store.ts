// The shell's secret store (V01-R13, ADR 0010). Values are encrypted with Electron's
// safeStorage, whose key the OS protects (macOS Keychain, Windows DPAPI, Linux secret
// service); only the ciphertext is written, to one owner-only file in the data
// directory. When that protection is unavailable nothing is stored and every
// answer says "unavailable" — there is no plaintext fallback. A file that cannot be
// read as this store's own is never overwritten: it may hold the user's keys.
import {
  SecretNameSchema,
  SecretValueSchema,
  type SecretPresenceResult,
  type SecretRead,
  type SecretWriteResult,
} from "@pki/contracts";
import { ensureDataDirectory } from "@pki/storage";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/** OS-protected encryption; a double in tests, never the real keychain. */
export interface Cipher {
  available(): Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  /** `reEncrypt`: the OS key rotated; store the value again. */
  decrypt(data: Buffer): Promise<{ text: string; reEncrypt: boolean }>;
}

/** The part of Electron's safeStorage used here (the asynchronous API, Electron 45). */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(text: string): Promise<Buffer>;
  decryptStringAsync(data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend(): string;
}

/**
 * Linux without a recognised secret service encrypts with a hard-coded password
 * (`basic_text`); `unknown` is before app ready. Neither protects anything.
 */
const UNPROTECTED_LINUX_BACKENDS = new Set(["basic_text", "unknown"]);

export function electronCipher(safeStorage: SafeStorageLike, platform: NodeJS.Platform): Cipher {
  return {
    // The asynchronous encryptor starts lazily on its first use, so it is asked first;
    // only then is Linux's backend name read. Any doubt is "unavailable" (fail closed).
    async available() {
      try {
        if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
        return !(
          platform === "linux" &&
          UNPROTECTED_LINUX_BACKENDS.has(safeStorage.getSelectedStorageBackend())
        );
      } catch {
        return false;
      }
    },
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    async decrypt(data) {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(data);
      return { text: result, reEncrypt: shouldReEncrypt };
    },
  };
}

const SecretFileSchema = z.strictObject({
  version: z.literal(1),
  secrets: z.record(SecretNameSchema, z.base64()),
});

export interface SecretStore {
  set(name: string, value: string): Promise<SecretWriteResult>;
  has(name: string): Promise<SecretPresenceResult>;
  delete(name: string): Promise<SecretWriteResult>;
  /** For the backend's request just before a call; the page has no way to reach it. */
  read(name: string): Promise<SecretRead>;
}

const UNAVAILABLE = { ok: false, error: "unavailable" } as const;

export function createSecretStore(options: { file: string; cipher: Cipher }): SecretStore {
  const { file, cipher } = options;

  /** The stored ciphertexts, or undefined when the file is not this store's. */
  function load(): Map<string, string> | undefined {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Map() : undefined;
    }
    try {
      const parsed = SecretFileSchema.safeParse(JSON.parse(text));
      return parsed.success ? new Map(Object.entries(parsed.data.secrets)) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Atomic: a new owner-only file beside the old one, then renamed over it. */
  function save(secrets: Map<string, string>): boolean {
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      ensureDataDirectory(dirname(file));
      const content = JSON.stringify({ version: 1, secrets: Object.fromEntries(secrets) });
      writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
      return true;
    } catch {
      rmSync(temp, { force: true });
      return false;
    }
  }

  async function encrypted(value: string): Promise<string | undefined> {
    try {
      return (await cipher.encrypt(value)).toString("base64");
    } catch {
      return undefined;
    }
  }

  // One operation at a time: each reads the file, changes it and writes it back.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  }

  return {
    set: (name, value) =>
      exclusive(async () => {
        if (!(await cipher.available())) return UNAVAILABLE;
        const secrets = load();
        const sealed = secrets && (await encrypted(value));
        if (!secrets || sealed === undefined) return UNAVAILABLE;
        secrets.set(name, sealed);
        return save(secrets) ? { ok: true } : UNAVAILABLE;
      }),
    // No entry is known without the OS: the keychain is touched only for a stored key.
    has: (name) =>
      exclusive(async () => {
        const secrets = load();
        if (!secrets) return UNAVAILABLE;
        if (!secrets.has(name)) return { ok: true, present: false };
        return (await cipher.available()) ? { ok: true, present: true } : UNAVAILABLE;
      }),
    // No cipher needed: the user can always remove a key.
    delete: (name) =>
      exclusive(async () => {
        const secrets = load();
        if (!secrets) return UNAVAILABLE;
        if (!secrets.delete(name)) return { ok: true };
        return save(secrets) ? { ok: true } : UNAVAILABLE;
      }),
    read: (name) =>
      exclusive(async (): Promise<SecretRead> => {
        if (!(await cipher.available())) return { state: "unavailable" };
        const secrets = load();
        if (!secrets) return { state: "unavailable" };
        const sealed = secrets.get(name);
        if (sealed === undefined) return { state: "missing" };
        let opened: { text: string; reEncrypt: boolean };
        try {
          opened = await cipher.decrypt(Buffer.from(sealed, "base64"));
        } catch {
          return { state: "unavailable" };
        }
        if (!SecretValueSchema.safeParse(opened.text).success) return { state: "unavailable" };
        if (opened.reEncrypt) {
          const resealed = await encrypted(opened.text);
          if (resealed !== undefined) save(secrets.set(name, resealed));
        }
        return { state: "present", value: opened.text };
      }),
  };
}
