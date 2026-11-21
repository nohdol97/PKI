// Egress policy and consent (V01-R12, ADR 0014): the Broker asks `decide` before
// every attempt. Two steps, in order: ① a consent exists for this Provider at its
// current destination and the current policy version ② the rules allow this task
// kind and data class. Rules come from the deployment (`siteRules`, a build-time
// input from the composition root, never a setting) and from the consent (allow
// the chosen classes for that Provider, every task kind). A deny wins; no
// matching rule denies; a deployment's deny is not overturned by consent.
// The policy version is computed from the rules in force, so editing any rule
// invalidates every consent given before (no hand-bumped number).
import {
  DATA_CLASSES,
  PROVIDER_IDS,
  providerEgress,
  TASK_KINDS,
  type ConsentList,
  type DataClassification,
  type ProviderId,
} from "@pki/contracts";
import { deleteConsent, readConsent, readSetting, saveConsent, type SqlDriver } from "@pki/storage";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { EgressInput, EgressPolicy } from "./broker.ts";

const any = z.literal("*");
export const EgressRuleSchema = z.strictObject({
  provider: z.union([z.enum(PROVIDER_IDS), any]),
  taskKind: z.union([z.enum(TASK_KINDS), any]),
  classification: z.union([z.enum(DATA_CLASSES), any]),
  effect: z.enum(["allow", "deny"]),
});
export type EgressRule = z.infer<typeof EgressRuleSchema>;

/** The public repository's deployment rules: none, so nothing leaves without consent. */
export const PUBLIC_SITE_RULES: readonly EgressRule[] = Object.freeze([]);

/** Setting key of the OpenAI-compatible endpoint (site-setup.md); its host is the destination. */
export const OPENAI_BASE_URL_SETTING = "providers.openaiCompatible.baseUrl";

/**
 * A CLI sends to whatever vendor service the CLI itself chooses (ADR 0014), so its
 * destination is named after the CLI. The local model stays on this PC.
 */
const FIXED_DESTINATIONS: Partial<Record<ProviderId, string>> = {
  "claude-code": "vendor:claude-code",
  codex: "vendor:codex",
  "local-model": "local-model",
};
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export type DenyReason =
  | "destination-unavailable"
  | "insecure-endpoint"
  | "no-consent"
  | "consent-stale-destination"
  | "consent-stale-policy"
  | "rule-denied"
  | "no-matching-rule";

const matches = (value: string, pattern: string) => pattern === "*" || pattern === value;

/** "deny" if any matching rule denies, else "allow" if any allows, else "none". */
export function evaluateRules(
  rules: readonly EgressRule[],
  input: EgressInput,
): "allow" | "deny" | "none" {
  const hits = rules.filter(
    (r) =>
      matches(input.providerId, r.provider) &&
      matches(input.taskKind, r.taskKind) &&
      matches(input.classification, r.classification),
  );
  if (hits.some((r) => r.effect === "deny")) return "deny";
  return hits.length > 0 ? "allow" : "none";
}

/** A digest of the class list and every deployment rule, field by field, in order. */
export function computePolicyVersion(rules: readonly EgressRule[]): string {
  const canonical = JSON.stringify({
    classes: DATA_CLASSES,
    rules: rules.map((r) => [r.provider, r.taskKind, r.classification, r.effect]),
  });
  return `pv-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

export interface EgressPolicyOptions {
  db: SqlDriver;
  siteRules?: readonly EgressRule[];
  /** `http` to a loopback endpoint: development and test builds only (T09 supplies the build kind). */
  allowLoopbackHttp?: boolean;
  now?: () => Date;
}

export type Destination =
  { destination: string } | { problem: "destination-unavailable" | "insecure-endpoint" };

/** The Broker's EgressPolicy, plus what the consent screen reads and changes. */
export interface EgressControls extends EgressPolicy {
  policyVersion(): string;
  destination(providerId: ProviderId): Destination;
  overview(): ConsentList;
  /** Consent at the current destination and policy version; replaces an earlier one. */
  grant(
    providerId: ProviderId,
    allowedClasses: readonly DataClassification[],
  ): ConsentList | { error: "destination-unavailable" };
  revoke(providerId: ProviderId): ConsentList;
}

export function createEgressPolicy(options: EgressPolicyOptions): EgressControls {
  const { db } = options;
  // invalid deployment rules stop the backend from starting rather than allow anything
  const siteRules = Object.freeze(
    z.array(EgressRuleSchema).parse(options.siteRules ?? PUBLIC_SITE_RULES),
  );
  const version = computePolicyVersion(siteRules);
  const now = options.now ?? (() => new Date());

  function endpointHost(): Destination {
    const raw = readSetting(db, OPENAI_BASE_URL_SETTING);
    if (raw === undefined) return { problem: "destination-unavailable" };
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { problem: "destination-unavailable" };
    }
    if (url.protocol === "https:") return { destination: url.host };
    if (url.protocol === "http:" && options.allowLoopbackHttp && LOOPBACK_HOSTS.has(url.hostname)) {
      return { destination: url.host };
    }
    return { problem: "insecure-endpoint" };
  }

  function destination(providerId: ProviderId): Destination {
    if (providerId === "openai-compatible") return endpointHost();
    const fixed = FIXED_DESTINATIONS[providerId];
    return fixed ? { destination: fixed } : { problem: "destination-unavailable" };
  }

  /** The stored consent's state against the current destination and version. */
  function consentOf(providerId: ProviderId, current: Destination) {
    const stored = readConsent(db, providerId);
    if (!stored) return undefined;
    const allowedClasses = DATA_CLASSES.filter((c) => stored.allowedClasses.includes(c));
    const state =
      !("destination" in current) || stored.destination !== current.destination
        ? "stale-destination"
        : stored.policyVersion !== version
          ? "stale-policy"
          : "valid";
    return { ...stored, allowedClasses, state } as const;
  }

  function decide(input: EgressInput) {
    const deny = (reason: DenyReason) => ({ allowed: false, reason }) as const;
    const current = destination(input.providerId);
    if (!("destination" in current)) return deny(current.problem);
    const consent = consentOf(input.providerId, current);
    if (!consent) return deny("no-consent");
    if (consent.state === "stale-destination") return deny("consent-stale-destination");
    if (consent.state === "stale-policy") return deny("consent-stale-policy");
    const consented = consent.allowedClasses.map((classification): EgressRule => ({
      provider: input.providerId,
      taskKind: "*",
      classification,
      effect: "allow",
    }));
    const verdict = evaluateRules([...siteRules, ...consented], input);
    if (verdict === "deny") return deny("rule-denied");
    if (verdict === "none") return deny("no-matching-rule");
    return { allowed: true, destination: current.destination, policyVersion: version } as const;
  }

  function overview(): ConsentList {
    return {
      policyVersion: version,
      classes: [...DATA_CLASSES],
      providers: PROVIDER_IDS.map((providerId) => {
        const current = destination(providerId);
        const consent = consentOf(providerId, current);
        return {
          providerId,
          egress: providerEgress(providerId),
          destination: "destination" in current ? current.destination : null,
          destinationProblem: "problem" in current ? current.problem : null,
          consent: consent
            ? {
                allowedClasses: consent.allowedClasses,
                destination: consent.destination,
                policyVersion: consent.policyVersion,
                grantedAt: consent.grantedAt,
                state: consent.state,
              }
            : null,
        };
      }),
    };
  }

  return {
    decide,
    policyVersion: () => version,
    destination,
    overview,
    grant(providerId, allowedClasses) {
      const current = destination(providerId);
      if (!("destination" in current)) return { error: "destination-unavailable" };
      saveConsent(db, {
        provider: providerId,
        destination: current.destination,
        policyVersion: version,
        allowedClasses: DATA_CLASSES.filter((c) => allowedClasses.includes(c)),
        grantedAt: now().toISOString(),
      });
      return overview();
    },
    revoke(providerId) {
      deleteConsent(db, providerId);
      return overview();
    },
  };
}
