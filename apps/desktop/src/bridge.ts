// The functions the preload gives the screen, and nothing else (spec "API와 preload",
// V01-R4): the session, secret store/check/delete (no function reads a value back) and
// opening an external https link after the user confirms. The preload passes the page's
// arguments through unchanged; every call is checked here against its sender and its
// schema before anything happens.
import { SecretNameSchema, SecretValueSchema, type Session } from "@pki/contracts";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { onAppOrigin } from "./app-protocol.ts";
import type { SecretStore } from "./secret-store.ts";

export const BRIDGE = {
  getSession: "pki:get-session",
  setSecret: "pki:set-secret",
  hasSecret: "pki:has-secret",
  deleteSecret: "pki:delete-secret",
  openExternal: "pki:open-external",
  pickLocation: "pki:pick-location",
} as const;
export type BridgeFunction = keyof typeof BRIDGE;

function isPlainHttps(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
}
const ExternalUrl = z.string().max(2048).refine(isPlainHttps);

const INPUTS = {
  getSession: z.tuple([]),
  setSecret: z.tuple([SecretNameSchema, SecretValueSchema]),
  hasSecret: z.tuple([SecretNameSchema]),
  deleteSecret: z.tuple([SecretNameSchema]),
  openExternal: z.tuple([ExternalUrl]),
  pickLocation: z.tuple([z.literal("folder")]),
} satisfies Record<BridgeFunction, z.ZodType>;

export interface ExternalTarget {
  href: string;
  hostname: string;
}

export interface BridgeDeps {
  session: Session;
  /** Stores, checks and deletes; the page has no function that reads a value back. */
  secrets: Pick<SecretStore, "set" | "has" | "delete">;
  /**
   * Asks the user before a link leaves the app; true only on an explicit yes. Gets the
   * normalised href and its hostname (punycode), the form that will actually open.
   */
  confirmExternal(target: ExternalTarget): Promise<boolean>;
  /** Hands the same normalised href to the OS browser. */
  openExternal(href: string): Promise<void>;
  /** The OS folder picker: the path the user chose, undefined when cancelled (I02B-R37). */
  pickLocation(type: "folder"): Promise<string | undefined>;
  /** Gives the backend the picked path under a ticket; false when no backend is running. */
  registerLocationTicket(input: { ticket: string; kind: "folder"; path: string }): boolean;
}

/** Each takes the sender frame's URL and the page's arguments as received. */
export type BridgeHandlers = Record<
  BridgeFunction,
  (senderUrl: string | undefined, args: unknown[]) => Promise<unknown>
>;

function checked<Name extends BridgeFunction>(
  name: Name,
  run: (args: z.infer<(typeof INPUTS)[Name]>) => Promise<unknown>,
) {
  return async (senderUrl: string | undefined, args: unknown[]) => {
    if (!onAppOrigin(senderUrl)) throw new Error("forbidden-sender");
    const parsed = INPUTS[name].safeParse(args);
    if (!parsed.success) throw new Error("invalid-input");
    return run(parsed.data as z.infer<(typeof INPUTS)[Name]>);
  };
}

export function createBridgeHandlers(deps: BridgeDeps): BridgeHandlers {
  return {
    getSession: checked("getSession", async () => deps.session),
    setSecret: checked("setSecret", ([name, value]) => deps.secrets.set(name, value)),
    hasSecret: checked("hasSecret", ([name]) => deps.secrets.has(name)),
    deleteSecret: checked("deleteSecret", ([name]) => deps.secrets.delete(name)),
    openExternal: checked("openExternal", async ([url]) => {
      // Normalised once: the page's string may render differently (look-alike letters,
      // bidi controls) from what opens; the user confirms what opens.
      const { href, hostname } = new URL(url);
      if (!(await deps.confirmExternal({ href, hostname }))) return { opened: false };
      await deps.openExternal(href);
      return { opened: true };
    }),
    // the page gets a one-time ticket, never the path; the backend gets the path from here only (I02B-R37)
    pickLocation: checked("pickLocation", async ([type]) => {
      const path = await deps.pickLocation(type);
      if (path === undefined) return { ticket: null };
      const ticket = randomBytes(32).toString("base64url");
      return { ticket: deps.registerLocationTicket({ ticket, kind: type, path }) ? ticket : null };
    }),
  };
}
