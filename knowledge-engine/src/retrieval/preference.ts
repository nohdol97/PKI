import { NO_PREFERENCE, type PreferenceSignal } from "./types.ts";

export const PREFERENCE_SPAN = 1000;
export function feedbackPreference(): PreferenceSignal {
  return NO_PREFERENCE;
}
