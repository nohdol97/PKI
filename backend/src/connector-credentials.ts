// A Connector's credentials (I06): the stored name of a slot (R3), the declaration check (R2), the
// presence check before a Connector is made (R6), and the accessor a Connector reads through (R7).
// The value lives only in the shell's secret store; nothing here remembers one. Every refusal is the
// fixed ConnectorCredentialError, so no slot, name or value reaches a message.
import {
  CREDENTIAL_RETRY_MIN_MS,
  ConnectorCredentialError,
  isConnectorCredentialSecret,
  LoginDescriptionSchema,
  SecretReadSchema,
  SecretValueSchema,
  type ConnectorCredentials,
  type CredentialReason,
  type SecretPresence,
  type SecretSource,
} from "@pki/contracts";
import { createHash } from "node:crypto";

/** Provisional (I06-R2), one place: the most slots one instance may declare. */
export const MAX_CREDENTIAL_SLOTS = 8;
/** The shape of a slot name (I06-R2); also the tail of a stored name (`isConnectorCredentialSecret`). */
export const CREDENTIAL_SLOT_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
/** Provisional (I06-R6), one place: the one limit for the presence answers of all the slots (and for one read). */
export const CREDENTIAL_CHECK_TIMEOUT_MS = 3_000;
/** The shortest gap between two notice-driven rebuilds of a rejected instance; one value, in `@pki/contracts` (the screen reads it too). */
export { CREDENTIAL_RETRY_MIN_MS };

/** What the manager needs of the store: the calls an accessor and a presence check make (`write`: session slot only). */
export type CredentialStore = Pick<SecretSource, "read" | "has" | "write">;

/**
 * `connector.<first 32 hex of sha256(kind + "\n" + instanceId)>.<slot>`. The kind in
 * the hash keeps a reused instance ID from handing an old kind's value to a new one;
 * the name does not bind the origin system's address (I06-R3). A kind with a newline
 * would make the joined text ambiguous (I05-R7 keeps it out): refused here too.
 */
export function connectorCredentialName(kind: string, instanceId: string, slot: string): string {
  if (kind.includes("\n")) throw new RangeError("invalid credential kind");
  const hex = createHash("sha256").update(`${kind}\n${instanceId}`).digest("hex").slice(0, 32);
  const name = `connector.${hex}.${slot}`;
  if (!isConnectorCredentialSecret(name)) throw new RangeError("invalid credential slot");
  return name;
}

/**
 * Whether a declaration is well formed (I06-R2): a list of at most MAX_CREDENTIAL_SLOTS distinct names of
 * the slot shape. A value that throws when read (a fork's odd object) is not well formed.
 */
export function credentialSlotsValid(slots: unknown): slots is readonly string[] {
  try {
    return (
      Array.isArray(slots) &&
      slots.length <= MAX_CREDENTIAL_SLOTS &&
      slots.every((slot) => typeof slot === "string" && CREDENTIAL_SLOT_PATTERN.test(slot)) &&
      new Set(slots).size === slots.length
    );
  } catch {
    return false;
  }
}

/**
 * Whether an instance's interactive-login description is well formed (I06S-R1): the shared schema, and a
 * session slot that is one of the slots the same instance declares. A value that throws when read is not.
 */
export function loginValid(login: unknown, credentials: unknown): boolean {
  try {
    const parsed = LoginDescriptionSchema.safeParse(login);
    return parsed.success && Array.isArray(credentials) && credentials.includes(parsed.data.slot);
  } catch {
    return false;
  }
}

/** An instance's declared slots with their stored names; `"invalid"` for a declaration that cannot be used. */
export type CredentialDeclaration = readonly { slot: string; name: string }[];

/**
 * The slots and names of one instance. The slots are checked before any name is built (a bad slot would
 * throw there); no declaration is the empty one. A declaration or kind that cannot be named is `"invalid"`.
 */
export function declareCredentials(
  kind: string,
  instanceId: string,
  credentials: unknown,
): CredentialDeclaration | "invalid" {
  if (credentials === undefined) return [];
  if (!credentialSlotsValid(credentials)) return "invalid";
  try {
    return credentials.map((slot) => ({
      slot,
      name: connectorCredentialName(kind, instanceId, slot),
    }));
  } catch {
    return "invalid";
  }
}

/** Runs `work` for at most `ms`; undefined when it was late, and a late answer is dropped. Never throws. */
async function within<T>(work: () => Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .catch(() => undefined),
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The reason the answers of a presence check give before a Connector is made (I06-R9): a store that
 * cannot answer, then a value that is missing; none when every slot is there.
 */
export function reasonOfPresence(
  states: readonly SecretPresence[],
): Extract<CredentialReason, "credential-store-unavailable" | "credential-missing"> | undefined {
  if (states.includes("unavailable")) return "credential-store-unavailable";
  if (states.includes("missing")) return "credential-missing";
  return undefined;
}

/** What one Connector object's accessor handed it, and how to cut the accessor and judge a refusal. */
export interface CredentialAccess {
  /** The accessor `initialize` gets; every read of an undeclared slot is refused. */
  readonly credentials: ConnectorCredentials;
  /** Whether any slot is declared (a presence check has something to ask). */
  readonly declared: boolean;
  /** The last presence answer of each declared slot; unavailable before the first check. */
  states(): SecretPresence[];
  /** Asks the store whether each declared slot has a value, all at once under one limit (I06-R6). */
  check(): Promise<SecretPresence[]>;
  /** From now on every read is refused without asking the store (I06-R7). */
  revoke(): void;
  /**
   * The reason a Connector's refusal is given, from the store's answers (I06-R9): none when the
   * instance declares no slot or this object read an undeclared one; else the store being unusable, a
   * value missing, a value that could not be read, and last a refusal by the origin system.
   */
  judge(): Promise<CredentialReason | undefined>;
}

/** The accessor of one Connector object over `store` (none: a store that cannot be used). */
export function createCredentialAccess(
  declaration: CredentialDeclaration,
  store: CredentialStore | undefined,
  /** False while the object this accessor belongs to is abandoned before it was ever adopted (I06-R7). */
  live: () => boolean = () => true,
  /** The one slot a Connector may write (I06S-R7); none: the accessor only reads. */
  sessionSlot?: string,
): CredentialAccess {
  const names = new Map(declaration.map(({ slot, name }) => [slot, name]));
  const marks = { missing: false, unreadable: false, undeclared: false };
  let revoked = false;
  let last: SecretPresence[] = declaration.map(() => "unavailable");

  const check = async (): Promise<SecretPresence[]> => {
    const answers: (SecretPresence | undefined)[] = declaration.map(() => undefined);
    if (store && declaration.length > 0) {
      await within(
        () =>
          Promise.all(
            declaration.map(async ({ name }, i) => {
              let answer: unknown;
              try {
                answer = await store.has(name);
              } catch {
                answer = undefined;
              }
              answers[i] = answer === "present" || answer === "missing" ? answer : "unavailable";
            }),
          ),
        CREDENTIAL_CHECK_TIMEOUT_MS,
      );
    }
    last = answers.map((answer) => answer ?? "unavailable");
    return [...last];
  };

  const refuse = (): never => {
    throw new ConnectorCredentialError();
  };

  const credentials: ConnectorCredentials = {
    async read(slot) {
      if (revoked || !live()) return refuse();
      const name = typeof slot === "string" ? names.get(slot) : undefined;
      if (name === undefined || store === undefined) {
        if (name === undefined) marks.undeclared = true;
        else marks.unreadable = true;
        return refuse();
      }
      const raw = await within(() => store.read(name), CREDENTIAL_CHECK_TIMEOUT_MS);
      if (revoked || !live()) return refuse(); // cut while it waited: the value goes nowhere
      const answer = SecretReadSchema.safeParse(raw);
      if (answer.success && answer.data.state === "present") return answer.data.value;
      if (answer.success && answer.data.state === "missing") marks.missing = true;
      else marks.unreadable = true; // unavailable, late, thrown or of a wrong shape
      return refuse();
    },
    async write(slot, value) {
      if (revoked || !live()) return refuse();
      const name = sessionSlot !== undefined && slot === sessionSlot ? names.get(slot) : undefined;
      // one line within the shell's limit; a value the shell would refuse is not sent (I06S-R7)
      if (
        name === undefined ||
        store?.write === undefined ||
        !SecretValueSchema.safeParse(value).success ||
        /[\r\n]/.test(value)
      ) {
        return refuse();
      }
      const write = store.write.bind(store);
      const answer = await within(() => write(name, value), CREDENTIAL_CHECK_TIMEOUT_MS);
      if (revoked || !live() || answer !== "done") return refuse();
    },
  };

  return {
    credentials,
    declared: declaration.length > 0,
    states: () => [...last],
    check,
    revoke: () => void (revoked = true),
    async judge() {
      if (declaration.length === 0 || marks.undeclared) return undefined;
      const fromStore = reasonOfPresence(await check());
      if (fromStore) return fromStore;
      if (marks.missing) return "credential-missing";
      if (marks.unreadable) return "credential-unreadable";
      return "credential-rejected";
    },
  };
}

/** An accessor that refuses every read: what `site-check` hands `initialize` (I06-R8). */
export const REFUSING_CREDENTIALS: ConnectorCredentials = createCredentialAccess(
  [],
  undefined,
).credentials;
