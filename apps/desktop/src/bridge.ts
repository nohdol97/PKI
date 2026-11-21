// The functions the preload gives the screen, and nothing else (spec "API와 preload",
// V01-R4): the session, secret store/check/delete (no function reads a value back) and
// opening an external https link after the user confirms. The preload passes the page's
// arguments through unchanged; every call is checked here against its sender and its
// schema before anything happens.
import type { Session } from "@pki/contracts";
import { z } from "zod";
import { onAppOrigin } from "./app-protocol.ts";

export const BRIDGE = {
  getSession: "pki:get-session",
  setSecret: "pki:set-secret",
  hasSecret: "pki:has-secret",
  deleteSecret: "pki:delete-secret",
  openExternal: "pki:open-external",
} as const;
export type BridgeFunction = keyof typeof BRIDGE;

const SecretName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const SecretValue = z.string().min(1).max(8192);

function isPlainHttps(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
}
const ExternalUrl = z.string().max(2048).refine(isPlainHttps);

const INPUTS = {
  getSession: z.tuple([]),
  setSecret: z.tuple([SecretName, SecretValue]),
  hasSecret: z.tuple([SecretName]),
  deleteSecret: z.tuple([SecretName]),
  openExternal: z.tuple([ExternalUrl]),
} satisfies Record<BridgeFunction, z.ZodType>;

/** The secret store arrives with T11; until then nothing is kept, in plaintext or otherwise. */
const SECRETS_NOT_IMPLEMENTED = { ok: false, error: "not-implemented" } as const;

export interface BridgeDeps {
  session: Session;
  /** Asks the user before a link leaves the app; true only on an explicit yes. */
  confirmExternal(url: string): Promise<boolean>;
  /** Hands the link to the OS browser. */
  openExternal(url: string): Promise<void>;
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
    setSecret: checked("setSecret", async () => SECRETS_NOT_IMPLEMENTED),
    hasSecret: checked("hasSecret", async () => SECRETS_NOT_IMPLEMENTED),
    deleteSecret: checked("deleteSecret", async () => SECRETS_NOT_IMPLEMENTED),
    openExternal: checked("openExternal", async ([url]) => {
      if (!(await deps.confirmExternal(url))) return { opened: false };
      await deps.openExternal(url);
      return { opened: true };
    }),
  };
}
