// The Broker's windowed call budget as a runtime setting (P7F-R3, spec 2026-11-24-P7-followups):
// the number of Provider attempts allowed in one window. Read once when the backend starts;
// the window length stays the Broker's default.
import { readSetting, type SqlDriver } from "@pki/storage";
import { DEFAULT_LIMITS, type BrokerLimits } from "./broker.ts";

/** Runtime setting (site-setup.md): the attempts allowed per window, a whole number from 1 to 10000. */
export const CALL_BUDGET_MAX_CALLS_SETTING = "providers.callBudget.maxCalls";

const MAX_CALLS_LIMIT = 10_000;

/**
 * The Broker's `callBudget`: the setting's value when it is a whole number from 1 to 10000,
 * otherwise the default (not the nearest allowed value, like `jobs.maxConcurrent`).
 */
export function readCallBudget(db: SqlDriver): BrokerLimits["callBudget"] {
  const value = readSetting(db, CALL_BUDGET_MAX_CALLS_SETTING);
  const maxCalls = value !== undefined && /^\d+$/.test(value) ? Number(value) : 0;
  return maxCalls >= 1 && maxCalls <= MAX_CALLS_LIMIT
    ? { maxCalls, windowMs: DEFAULT_LIMITS.callBudget.windowMs }
    : DEFAULT_LIMITS.callBudget;
}
