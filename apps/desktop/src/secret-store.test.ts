// V01-C5 `secrets`, the shell's half (V01-R13, ADR 0010): a stored key lives in the
// secret file only as ciphertext from the OS-protected cipher; without that cipher
// nothing is written at all (no plaintext fallback); a damaged file is never
// overwritten. Tests use a cipher double — never the real keychain.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSecretStore, electronCipher, type Cipher } from "./secret-store.ts";

const CANARY = `sk-canary-${randomUUID()}`;
const OPENAI_API_KEY_SECRET = `openai-compatible.api-key.${"a".repeat(32)}`;

/** Reversible and visibly not the plaintext: XOR with a fixed byte, behind a marker. */
function doubleCipher(available = true) {
  const calls = { encrypt: 0, decrypt: 0 };
  const cipher: Cipher & { calls: typeof calls; rotate: boolean } = {
    calls,
    rotate: false,
    available: async () => available,
    async encrypt(text) {
      calls.encrypt++;
      return Buffer.concat([Buffer.from("ENC1"), Buffer.from(text, "utf8").map((b) => b ^ 0x5a)]);
    },
    async decrypt(data) {
      calls.decrypt++;
      if (!data.subarray(0, 4).equals(Buffer.from("ENC1"))) throw new Error("bad ciphertext");
      const text = Buffer.from(data.subarray(4).map((b) => b ^ 0x5a)).toString("utf8");
      return { text, reEncrypt: cipher.rotate };
    },
  };
  return cipher;
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-secret-store-"));
  file = join(dir, "data", "secrets.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function everyFile(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe("secret store", () => {
  it("stores, checks, reads and deletes; the file never holds the plaintext", async () => {
    const store = createSecretStore({ file, cipher: doubleCipher() });
    expect(await store.has(OPENAI_API_KEY_SECRET)).toEqual({ ok: true, present: false });
    expect(await store.set(OPENAI_API_KEY_SECRET, CANARY)).toEqual({ ok: true });
    expect(await store.has(OPENAI_API_KEY_SECRET)).toEqual({ ok: true, present: true });
    expect(await store.read(OPENAI_API_KEY_SECRET)).toEqual({ state: "present", value: CANARY });
    expect(await store.read("other")).toEqual({ state: "missing" });

    for (const path of everyFile(dir)) {
      expect(readFileSync(path).includes(CANARY), path).toBe(false);
    }
    // what is stored is the cipher's output, not some other encoding of the plaintext
    const stored = JSON.parse(readFileSync(file, "utf8")).secrets[OPENAI_API_KEY_SECRET];
    expect(Buffer.from(stored, "base64")).toEqual(await doubleCipher().encrypt(CANARY));
    expect(everyFile(dir)).toEqual([file]); // no temporary file left behind
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o700);
    }

    expect(await store.delete(OPENAI_API_KEY_SECRET)).toEqual({ ok: true });
    expect(await store.has(OPENAI_API_KEY_SECRET)).toEqual({ ok: true, present: false });
    expect(await store.read(OPENAI_API_KEY_SECRET)).toEqual({ state: "missing" });
  });

  it("keeps several secrets apart and survives a new store on the same file", async () => {
    const cipher = doubleCipher();
    const first = createSecretStore({ file, cipher });
    await first.set("a", "value-a");
    await first.set("b", "value-b");
    const again = createSecretStore({ file, cipher });
    expect(await again.read("a")).toEqual({ state: "present", value: "value-a" });
    expect(await again.read("b")).toEqual({ state: "present", value: "value-b" });
  });

  it("serialises concurrent writes, losing none", async () => {
    const store = createSecretStore({ file, cipher: doubleCipher() });
    await Promise.all(["a", "b", "c", "d"].map((n) => store.set(n, `value-${n}`)));
    for (const n of ["a", "b", "c", "d"]) {
      expect(await store.read(n)).toEqual({ state: "present", value: `value-${n}` });
    }
  });

  it("writes nothing and says unavailable when the OS protection is unavailable", async () => {
    const cipher = doubleCipher(false);
    const store = createSecretStore({ file, cipher });
    expect(await store.set(OPENAI_API_KEY_SECRET, CANARY)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(existsSync(file)).toBe(false);
    expect(everyFile(dir)).toEqual([]);
    expect(cipher.calls.encrypt).toBe(0);
    // nothing stored is known without the OS; a stored key it cannot open is unavailable
    expect(await store.has(OPENAI_API_KEY_SECRET)).toEqual({ ok: true, present: false });
    expect(await store.read(OPENAI_API_KEY_SECRET)).toEqual({ state: "unavailable" });
    await createSecretStore({ file, cipher: doubleCipher() }).set(OPENAI_API_KEY_SECRET, CANARY);
    expect(await store.has(OPENAI_API_KEY_SECRET)).toEqual({ ok: false, error: "unavailable" });
  });

  it("checks presence of a missing key without asking the OS (no keychain access)", async () => {
    const cipher = doubleCipher();
    const available = vi.spyOn(cipher, "available");
    const store = createSecretStore({ file, cipher });
    expect(await store.has(OPENAI_API_KEY_SECRET)).toEqual({ ok: true, present: false });
    expect(available).not.toHaveBeenCalled();
  });

  it("deletes even while the OS protection is unavailable", async () => {
    await createSecretStore({ file, cipher: doubleCipher() }).set("a", "value-a");
    const store = createSecretStore({ file, cipher: doubleCipher(false) });
    expect(await store.delete("a")).toEqual({ ok: true });
    expect(await createSecretStore({ file, cipher: doubleCipher() }).read("a")).toEqual({
      state: "missing",
    });
  });

  it("deletes every other backend-readable key, keeping the current one and other names", async () => {
    const cipher = doubleCipher(false); // like delete, it needs no OS protection
    const writer = createSecretStore({ file, cipher: doubleCipher() });
    const other = `openai-compatible.api-key.${"b".repeat(32)}`;
    await writer.set(OPENAI_API_KEY_SECRET, "value-current");
    await writer.set(other, "value-other");
    await writer.set("unrelated", "value-unrelated");
    const store = createSecretStore({ file, cipher });
    expect(await store.deleteOthers(OPENAI_API_KEY_SECRET)).toEqual({ ok: true });
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).secrets).sort()).toEqual(
      [OPENAI_API_KEY_SECRET, "unrelated"].sort(),
    );
    expect(await store.deleteOthers(OPENAI_API_KEY_SECRET)).toEqual({ ok: true }); // nothing left
  });

  it("reports a value it cannot decrypt as unavailable", async () => {
    await createSecretStore({ file, cipher: doubleCipher() }).set("a", "value-a");
    const broken: Cipher = {
      ...doubleCipher(),
      decrypt: () => Promise.reject(new Error("no key")),
    };
    expect(await createSecretStore({ file, cipher: broken }).read("a")).toEqual({
      state: "unavailable",
    });
  });

  it("re-encrypts a value the OS key rotation asks for", async () => {
    const cipher = doubleCipher();
    const store = createSecretStore({ file, cipher });
    await store.set("a", "value-a");
    cipher.rotate = true;
    expect(await store.read("a")).toEqual({ state: "present", value: "value-a" });
    expect(cipher.calls.encrypt).toBe(2);
  });

  it.each([
    ["not JSON", "{"],
    ["a wrong shape", JSON.stringify({ version: 1, secrets: { a: 5 } })],
    ["an unknown version", JSON.stringify({ version: 2, secrets: {} })],
  ])("never overwrites a damaged file (%s)", async (_name, content) => {
    const store = createSecretStore({ file, cipher: doubleCipher() });
    await store.set("a", "value-a");
    writeFileSync(file, content);
    expect(await store.set("b", CANARY)).toEqual({ ok: false, error: "unavailable" });
    expect(await store.delete("a")).toEqual({ ok: false, error: "unavailable" });
    expect(await store.deleteOthers("a")).toEqual({ ok: false, error: "unavailable" });
    expect(await store.has("a")).toEqual({ ok: false, error: "unavailable" });
    expect(await store.read("a")).toEqual({ state: "unavailable" });
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});

describe("secret store, Connector credential names (I06-C1 ③⑤, I06-C15 ①②④)", () => {
  const HEX = "0123456789abcdef".repeat(2);
  const CONNECTOR_NAME = `connector.${HEX}.token`;
  const canaryShapes = (value: string) => [
    Buffer.from(value, "utf8"),
    Buffer.from(Buffer.from(value, "utf8").toString("base64")),
    Buffer.from(Buffer.from(value, "utf8").toString("hex")),
  ];

  it("stores a canary under a credential name with no plaintext, base64 or hex shape on disk", async () => {
    const store = createSecretStore({ file, cipher: doubleCipher() });
    const set = await store.set(CONNECTOR_NAME, CANARY);
    const has = await store.has(CONNECTOR_NAME);
    expect(set).toEqual({ ok: true });
    expect(has).toEqual({ ok: true, present: true });
    expect(JSON.stringify([set, has])).not.toContain(CANARY);
    for (const path of everyFile(dir)) {
      for (const shape of canaryShapes(CANARY))
        expect(readFileSync(path).includes(shape)).toBe(false);
    }
    const removed = await store.delete(CONNECTOR_NAME);
    expect(removed).toEqual({ ok: true });
    expect(JSON.stringify(removed)).not.toContain(CANARY);
    expect(await store.has(CONNECTOR_NAME)).toEqual({ ok: true, present: false });
  });

  it("writes nothing for a credential name while the OS protection is unavailable", async () => {
    const store = createSecretStore({ file, cipher: doubleCipher(false) });
    expect(await store.set(CONNECTOR_NAME, CANARY)).toEqual({ ok: false, error: "unavailable" });
    expect(existsSync(file)).toBe(false);
    expect(everyFile(dir)).toEqual([]);
  });

  it("keeps Connector credentials when a Provider prune runs, and deletes the other Provider keys", async () => {
    const writer = createSecretStore({ file, cipher: doubleCipher() });
    const other = `openai-compatible.api-key.${"b".repeat(32)}`;
    await writer.set(OPENAI_API_KEY_SECRET, "value-current");
    await writer.set(other, "value-other");
    await writer.set(CONNECTOR_NAME, "value-connector");
    expect(await writer.deleteOthers(OPENAI_API_KEY_SECRET)).toEqual({ ok: true });
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).secrets).sort()).toEqual(
      [OPENAI_API_KEY_SECRET, CONNECTOR_NAME].sort(),
    );
    expect(await writer.read(CONNECTOR_NAME)).toEqual({
      state: "present",
      value: "value-connector",
    });
  });

  it("answers `has` as before: an empty slot is absent even without the OS protection", async () => {
    const store = createSecretStore({ file, cipher: doubleCipher(false) });
    expect(await store.has(CONNECTOR_NAME)).toEqual({ ok: true, present: false });
    expect(await store.has(OPENAI_API_KEY_SECRET)).toEqual({ ok: true, present: false });
  });

  it("tells the shell whether the cipher is usable", async () => {
    expect(await createSecretStore({ file, cipher: doubleCipher() }).available()).toBe(true);
    expect(await createSecretStore({ file, cipher: doubleCipher(false) }).available()).toBe(false);
  });
});

describe("electronCipher", () => {
  const safeStorage = () => ({
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (text: string) => Buffer.from(`x${text}`)),
    decryptStringAsync: vi.fn(async (data: Buffer) => ({
      result: data.toString().slice(1),
      shouldReEncrypt: false,
    })),
    getSelectedStorageBackend: vi.fn(() => "gnome_libsecret" as const),
  });

  it("uses the asynchronous safeStorage API", async () => {
    const s = safeStorage();
    const cipher = electronCipher(s, "darwin");
    expect(await cipher.available()).toBe(true);
    expect(await cipher.decrypt(await cipher.encrypt("v"))).toEqual({
      text: "v",
      reEncrypt: false,
    });
    expect(s.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it("asks the async encryptor before reading Linux's backend name", async () => {
    const order: string[] = [];
    const s = {
      ...safeStorage(),
      isAsyncEncryptionAvailable: async () => (order.push("async"), true),
      getSelectedStorageBackend: () => (order.push("backend"), "gnome_libsecret" as const),
    };
    expect(await electronCipher(s, "linux").available()).toBe(true);
    expect(order).toEqual(["async", "backend"]);
  });

  it.each(["basic_text", "unknown"] as const)(
    "refuses Linux's %s backend, whose key is not OS-protected",
    async (backend) => {
      const s = { ...safeStorage(), getSelectedStorageBackend: () => backend };
      expect(await electronCipher(s, "linux").available()).toBe(false);
    },
  );

  it("is unavailable when safeStorage says so or fails", async () => {
    const no = { ...safeStorage(), isAsyncEncryptionAvailable: async () => false };
    expect(await electronCipher(no, "win32").available()).toBe(false);
    const fails = {
      ...safeStorage(),
      isAsyncEncryptionAvailable: () => Promise.reject(new Error("keychain")),
    };
    expect(await electronCipher(fails, "darwin").available()).toBe(false);
  });
});
