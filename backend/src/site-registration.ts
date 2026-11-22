// What a deployment fork plugs into the product, as one object (I05-R1, R6 to R9): Connector kinds
// with the functions that make them, the instances to start, the mapping scope -> class and the scope
// policy. The fork's entry hands it to `runShell` and `runSiteCheck`; the public entries hand them the
// empty `publicSite`. A registration is merged onto the base set at the start; it can add site kinds
// and their instances and replace a placeholder, and it can take no public kind or public instance.
// It is a check of mistakes and not a sandbox: the fork's code is trusted code (the spec's
// "신뢰 경계와 남는 위험"), so the log and the start failure carry fixed codes and counts and never
// what the registration wrote or threw.
import { CONNECTOR_KIND_PATTERN, MAX_INSTANCE_ID_LENGTH, type Connector } from "@pki/contracts";
import { log, SCOPE_CLASSES, type ScopeGrading } from "@pki/providers";
import type { ScopePolicy } from "@pki/storage";
import { productConnectors, type ConnectorSet } from "./composition.ts";
import { bindConnectorScopes } from "./connector-scopes.ts";
import type { ConnectorFactory, ConnectorInstanceConfig } from "./connectors.ts";
import {
  isPublicInstanceId,
  PUBLIC_CONNECTOR_KINDS,
  SITE_CONNECTOR_KINDS,
} from "./public-kinds.ts";

/** The fork's part of the product; every field is optional and the empty object is the public repository's. */
export interface SiteRegistration {
  /** Kind name -> a function that makes a new Connector of it. */
  readonly connectorKinds?: Readonly<Record<string, ConnectorFactory>>;
  /** The instances the start makes (`id`, `kind`, `config`); only of the kinds this registration registers. */
  readonly connectorInstances?: readonly ConnectorInstanceConfig[];
  /** Access scope -> data class (S08); default `publicScopeGrading`. */
  readonly scopeGrading?: ScopeGrading;
  /** The access scope policy (S21); default the public one. */
  readonly scopePolicy?: ScopePolicy;
  /**
   * The fork's range file, imported statically (I07-R1): instance id -> scope
   * values, or null. Not typed narrowly on purpose; it is read and checked when used (I07-R3).
   * None: every instance's configured scope is unknown.
   */
  readonly connectorScopes?: unknown;
}

/** The public repository's registration: nothing. */
export const publicSite: SiteRegistration = Object.freeze({});

/** What a check can find; the first four drop their item at the start and the next two stop it. */
export type SiteRegistrationCode =
  | "kind-name-invalid"
  | "kind-reserved"
  | "instance-id-invalid"
  | "instance-id-duplicate"
  | "instance-kind-unknown"
  | "instance-kind-reserved"
  | "instance-id-reserved"
  | "kind-factory-threw"
  | "kind-manifest-mismatch"
  | "scope-grading-invalid"
  | "connector-scopes-field-invalid"
  | "connector-scopes-entry-invalid";

/** The violations that leave their item out and let the start go on (counted in the log). */
const DROPPED_CODES = [
  "kind-name-invalid",
  "kind-reserved",
  "instance-id-invalid",
  "instance-id-duplicate",
] as const satisfies readonly SiteRegistrationCode[];

/** The violations that stop the start: a try at what the public code keeps for itself. */
const STOPPING_CODES = [
  "instance-kind-reserved",
  "instance-id-reserved",
] as const satisfies readonly SiteRegistrationCode[];
export type StoppingCode = (typeof STOPPING_CODES)[number];

/** The start refused a registration (I05-R9): the message is fixed codes and counts, nothing the registration wrote. */
export class SiteRegistrationInvalidError extends Error {
  override name = "SiteRegistrationInvalidError";
  constructor(counts: readonly { code: StoppingCode; count: number }[]) {
    super(["site-registration-invalid", ...counts.map((c) => `${c.code}=${c.count}`)].join(" "));
  }
}

/**
 * Whether a mapping answers inside the closed set of classes. It is asked what it can be asked
 * without a real scope: `grade(null)`, `grade([])`, `strictest([])` (the three are the strictest class,
 * since a claim that cannot be shown safe is graded by them) and `strictest` of every class (a class
 * of the set). The classes are listed least strict first, so the strictest is the last. A mapping that
 * throws is invalid. The answer for each real scope is not checked here; the Broker refuses a bad one per call.
 */
export function scopeGradingValid(
  grading: ScopeGrading,
  classes: readonly string[] = SCOPE_CLASSES,
): boolean {
  const strictestClass = classes[classes.length - 1];
  try {
    const unknownScopes = [grading.grade(null), grading.grade([]), grading.strictest([])];
    const widest = grading.strictest(classes as readonly (typeof SCOPE_CLASSES)[number][]);
    return unknownScopes.every((answer) => answer === strictestClass) && classes.includes(widest);
  } catch {
    return false;
  }
}

interface Analysis {
  connectors: ConnectorSet;
  violations: SiteRegistrationCode[];
  /** The kind names this registration registered, in the order it listed them. */
  registered: string[];
}

/** The structure checks and the merge; no function of the registration is called. */
function analyse(site: SiteRegistration, base: ConnectorSet): Analysis {
  const violations: SiteRegistrationCode[] = [];
  const kinds: Record<string, ConnectorFactory> = { ...base.kinds };
  const registered: string[] = [];
  for (const [name, factory] of Object.entries(site.connectorKinds ?? {})) {
    if (!CONNECTOR_KIND_PATTERN.test(name)) {
      violations.push("kind-name-invalid");
    } else if (PUBLIC_CONNECTOR_KINDS.includes(name)) {
      violations.push("kind-reserved");
    } else {
      kinds[name] = factory;
      registered.push(name);
    }
  }
  // a placeholder the registration replaced frees its name's instance and its id
  const replaced = new Set(
    registered.filter((n) => (SITE_CONNECTOR_KINDS as readonly string[]).includes(n)),
  );
  const instances = base.instances.filter((i) => !replaced.has(i.kind));
  const baseIds = new Set(instances.map((i) => i.id));
  const seen = new Set<string>();
  for (const instance of site.connectorInstances ?? []) {
    const { id, kind } = instance;
    if (typeof id !== "string" || id.length < 1 || id.length > MAX_INSTANCE_ID_LENGTH) {
      violations.push("instance-id-invalid");
      continue;
    }
    if (seen.has(id)) {
      violations.push("instance-id-duplicate");
      continue;
    }
    seen.add(id);
    let stops = false;
    if (!registered.includes(kind)) {
      // a kind this registration did not register: a public one or the base's own is reserved; no other is a typo
      if (PUBLIC_CONNECTOR_KINDS.includes(kind) || Object.hasOwn(kinds, kind)) {
        violations.push("instance-kind-reserved");
        stops = true;
      } else {
        violations.push("instance-kind-unknown");
      }
    }
    if (isPublicInstanceId(id, replaced) || baseIds.has(id)) {
      violations.push("instance-id-reserved");
      stops = true;
    }
    if (!stops) instances.push(instance);
  }
  return { connectors: { instances, kinds }, violations, registered };
}

/**
 * The registration merged onto `base` (I05-R1): the base's kinds and instances, the registered kinds
 * (a placeholder name replaces that placeholder and its instance), and the instances that passed. What a
 * violation drops is not in the result; the violations are listed once per occurrence.
 */
export function mergeSiteRegistration(
  site: SiteRegistration,
  base: ConnectorSet,
): { connectors: ConnectorSet; violations: SiteRegistrationCode[] } {
  const { connectors, violations } = analyse(site, base);
  return { connectors, violations };
}

/**
 * The check a fork's `registration.test.ts` runs (I05-R9): the codes found, one per occurrence, and
 * an empty list for a registration that is fine. Besides the structure it asks each registered kind's
 * function once, and the mapping its few questions. The scopes value gives `connector-scopes-field-invalid` when it is not an object and
 * `connector-scopes-entry-invalid` once per registration when one or more entries are not well-formed. `base` default is the product's own set.
 */
export function checkSiteRegistration(
  site: SiteRegistration,
  base: ConnectorSet = productConnectors(),
): SiteRegistrationCode[] {
  const { violations, registered } = analyse(site, base);
  for (const name of registered) {
    let made: Connector;
    try {
      made = (site.connectorKinds as Record<string, ConnectorFactory>)[name]?.() as Connector;
    } catch {
      violations.push("kind-factory-threw");
      continue;
    }
    let type: unknown;
    try {
      type = made.manifest.type;
    } catch {
      type = undefined;
    }
    if (type !== name) violations.push("kind-manifest-mismatch");
  }
  if (site.scopeGrading && !scopeGradingValid(site.scopeGrading)) {
    violations.push("scope-grading-invalid");
  }
  // check only (I07-R5): the start goes on on the closed side, the instance or the whole value unknown
  const bound = bindConnectorScopes(site.connectorScopes);
  if (bound.state === "invalid") violations.push("connector-scopes-field-invalid");
  if (bound.rejected > 0) violations.push("connector-scopes-entry-invalid");
  return violations;
}

/** How many of each of `codes` the violations hold, in the order of `codes`, those with a count only. */
function countCodes<C extends SiteRegistrationCode>(
  violations: readonly SiteRegistrationCode[],
  codes: readonly C[],
): { code: C; count: number }[] {
  return codes
    .map((code) => ({ code, count: violations.filter((v) => v === code).length }))
    .filter((c) => c.count > 0);
}

/**
 * The error a registration that boot would refuse gives, or undefined (`site-check` reports it too, so
 * a registration that cannot start is never reported ok).
 */
export function stoppingError(
  violations: readonly SiteRegistrationCode[],
): SiteRegistrationInvalidError | undefined {
  const stops = countCodes(violations, STOPPING_CODES);
  return stops.length > 0 ? new SiteRegistrationInvalidError(stops) : undefined;
}

/**
 * The start's use of a registration (I05-R9, R12): the set to run with. The violations that leave
 * their item out are logged once per code with their count; the two that stop the start log the same and
 * throw `SiteRegistrationInvalidError`. Runs before the canonical DB and the ledger are touched.
 */
export function resolveSiteRegistration(site: SiteRegistration, base: ConnectorSet): ConnectorSet {
  const { connectors, violations } = mergeSiteRegistration(site, base);
  const stops = countCodes(violations, STOPPING_CODES);
  if (stops.length > 0) {
    for (const { code, count } of stops) log("site-registration-invalid", { code, count });
    throw new SiteRegistrationInvalidError(stops);
  }
  for (const { code, count } of countCodes(violations, DROPPED_CODES)) {
    log("site-registration-rejected", { code, count });
  }
  return connectors;
}
