// User action records (V01-R8): the Broker treats a call as a user call only if
// it names a record from its own ledger. The composition root hands the issuer to
// the API layer and the redeemer to the Broker, so code without the issuer (a job
// runner) cannot mint one. A record lives in memory only, belongs to the one
// request handled inside `during`, is used at most once and ends with the request.
import { randomUUID } from "node:crypto";

export interface UserActionIssuer {
  /** Opens a record for the request `handle` serves; it ends when `handle` settles. */
  during<T>(handle: (userActionId: string) => Promise<T>): Promise<T>;
}

export interface UserActionRedeemer {
  /** "ok" marks the record used; a record that ended or was never issued is "unknown". */
  redeem(userActionId: string): "ok" | "used" | "unknown";
}

export function createUserActionLedger(): {
  issuer: UserActionIssuer;
  redeemer: UserActionRedeemer;
} {
  const open = new Map<string, { used: boolean }>();
  return {
    issuer: {
      async during(handle) {
        const id = randomUUID();
        open.set(id, { used: false });
        try {
          return await handle(id);
        } finally {
          open.delete(id);
        }
      },
    },
    redeemer: {
      redeem(id) {
        const record = open.get(id);
        if (!record) return "unknown";
        if (record.used) return "used";
        record.used = true;
        return "ok";
      },
    },
  };
}
