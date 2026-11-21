// User action records (V01-R8): the Broker treats a call as a user call only if
// it names a record from its own ledger. The composition root hands the issuer to
// the API layer and the redeemer to the Broker, so code without the issuer (a job
// runner) cannot mint one. A record lives in memory only, belongs to the one
// request handled inside `during`, is used at most once and ends with the request.
// It also carries whether the user confirmed, for that one call, the
// unverified-isolation warning of the development build (V01-R10); only the
// issuer sets it, and it is never stored.
import { randomUUID } from "node:crypto";

export interface UserActionOptions {
  /** The user confirmed the unverified-isolation warning for this call. */
  acknowledgeUnverified?: boolean;
}

export interface UserActionIssuer {
  /** Opens a record for the request `handle` serves; it ends when `handle` settles. */
  during<T>(handle: (userActionId: string) => Promise<T>, options?: UserActionOptions): Promise<T>;
}

/** What a redeemed record says about the call it was opened for. */
export interface UserAction {
  readonly unverifiedAcknowledged: boolean;
}

export interface UserActionRedeemer {
  /** Marks the record used and returns it; a record that ended or was never issued is "unknown". */
  redeem(userActionId: string): UserAction | "used" | "unknown";
}

export function createUserActionLedger(): {
  issuer: UserActionIssuer;
  redeemer: UserActionRedeemer;
} {
  const open = new Map<string, { used: boolean; unverifiedAcknowledged: boolean }>();
  return {
    issuer: {
      async during(handle, options = {}) {
        const id = randomUUID();
        open.set(id, {
          used: false,
          unverifiedAcknowledged: options.acknowledgeUnverified === true,
        });
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
        return Object.freeze({ unverifiedAcknowledged: record.unverifiedAcknowledged });
      },
    },
  };
}
