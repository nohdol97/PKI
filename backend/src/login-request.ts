// The shell's request for an instance's login description (I06S-R3, D2), modelled on the reveal request
// (`local-reveal.ts`): a request id and an instance id, nothing a page could shape. The answer is the
// description with the stored name of the session slot, or `none`; it holds no secret value.
import type { LoginSettings } from "@pki/contracts";

/** The shell's request over the parent channel: exactly a request id and a connector id. */
export function loginRequest(data: unknown): { id: number; connectorId: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (Object.keys(data).sort().join(",") !== "connectorId,id,type") return undefined;
  const { type, id, connectorId } = data as Record<string, unknown>;
  if (type !== "login-request" || !Number.isSafeInteger(id) || (id as number) <= 0) {
    return undefined;
  }
  if (typeof connectorId !== "string" || connectorId.length < 1) return undefined;
  return { id: id as number, connectorId };
}

/** The message that answers `request`: the description, or `none` when the instance has no login. */
export function loginAnswer(id: number, login: LoginSettings | undefined) {
  return login === undefined ? { type: "login", id, none: true } : { type: "login", id, ...login };
}
