// The scope policy the backend runs until I04-T09 configures the real one. The read paths (I04-R13) ask
// `visible`, which asks `allows` every time; the placeholder `NO_POLICY_YET` throws there, which would hide
// every Source, Insight and evidence row on every screen. Until T09 this allows every scope set, as the
// default policy does (R14: one PC, one user), and keeps the placeholder's refusal for the other judgements,
// which nothing asks yet. I04-T09 replaces it in `productRegistry`, and this file is deleted with it.
import { NO_POLICY_YET } from "@pki/knowledge-engine";
import type { ScopePolicy } from "@pki/storage";

export const INTERIM_POLICY: ScopePolicy = { ...NO_POLICY_YET, allows: () => true };
