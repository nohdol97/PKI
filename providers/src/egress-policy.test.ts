// V01-C5 `egress-policy` (V01-R12, ADR 0014): the allow/deny table, deny first,
// no matching rule denies, mixed input takes the strictest class, and a
// deployment's deny rule is not overturned by consent. The policy version is
// computed from the rules in force, so any rule change gives a new version.
import type { DataClassification, ProviderId, TaskKind } from "@pki/contracts";
import { migrate, writeSetting, type SqlDriver } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strictest } from "./broker.ts";
import {
  computePolicyVersion,
  createEgressPolicy,
  evaluateRules,
  OPENAI_BASE_URL_SETTING,
  parseEndpoint,
  type EgressRule,
} from "./egress-policy.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
});
afterEach(() => db.close());

/** Grants with the destination and policy version the consent screen would show now. */
function grantAsShown(
  policy: ReturnType<typeof createEgressPolicy>,
  providerId: ProviderId,
  classes: DataClassification[],
) {
  const current = policy.destination(providerId);
  return policy.grant(providerId, classes, {
    destination: "destination" in current ? current.destination : "",
    policyVersion: policy.policyVersion(),
  });
}

const rule = (
  effect: EgressRule["effect"],
  provider: EgressRule["provider"] = "*",
  taskKind: EgressRule["taskKind"] = "*",
  classification: EgressRule["classification"] = "*",
): EgressRule => ({ provider, taskKind, classification, effect });

describe("evaluateRules: the allow/deny table", () => {
  const input = (
    providerId: ProviderId,
    taskKind: TaskKind,
    classification: DataClassification,
  ) => ({ providerId, taskKind, classification });

  it.each<[string, EgressRule[], ReturnType<typeof input>, "allow" | "deny" | "none"]>([
    ["no rules: nothing matches", [], input("codex", "extract", "synthetic"), "none"],
    [
      "exact allow",
      [rule("allow", "codex", "extract", "synthetic")],
      input("codex", "extract", "synthetic"),
      "allow",
    ],
    [
      "other provider does not match",
      [rule("allow", "codex")],
      input("claude-code", "extract", "synthetic"),
      "none",
    ],
    [
      "other task kind does not match",
      [rule("allow", "codex", "extract")],
      input("codex", "connection-test", "synthetic"),
      "none",
    ],
    [
      "other class does not match",
      [rule("allow", "codex", "*", "synthetic")],
      input("codex", "extract", "general"),
      "none",
    ],
    [
      "wildcards match all",
      [rule("allow")],
      input("openai-compatible", "connection-test", "general"),
      "allow",
    ],
    [
      "exact deny",
      [rule("deny", "codex", "extract", "general")],
      input("codex", "extract", "general"),
      "deny",
    ],
    [
      "deny wins over allow (deny listed last)",
      [rule("allow"), rule("deny", "codex")],
      input("codex", "extract", "synthetic"),
      "deny",
    ],
    [
      "deny wins over allow (deny listed first)",
      [rule("deny", "codex"), rule("allow")],
      input("codex", "extract", "synthetic"),
      "deny",
    ],
    [
      "a deny elsewhere does not block",
      [rule("allow"), rule("deny", "codex")],
      input("claude-code", "extract", "synthetic"),
      "allow",
    ],
  ])("%s", (_name, rules, given, expected) => {
    expect(evaluateRules(rules, given)).toBe(expected);
  });
});

describe("mixed input", () => {
  it("is graded by its strictest part, so a synthetic-only consent does not cover it", () => {
    const graded = [
      { classification: "synthetic" as const, malicious: false },
      { classification: "general" as const, malicious: false },
    ];
    const classification = strictest(graded);
    expect(classification).toBe("general");
    const policy = createEgressPolicy({ db });
    grantAsShown(policy, "claude-code", ["synthetic"]);
    expect(
      policy.decide({ providerId: "claude-code", taskKind: "extract", classification }),
    ).toEqual({ allowed: false, reason: "no-matching-rule" });
  });
});

describe("createEgressPolicy.decide", () => {
  it("denies every call by default: no site rules, no consent", () => {
    const policy = createEgressPolicy({ db });
    for (const providerId of ["claude-code", "codex", "local-model"] as const) {
      expect(
        policy.decide({ providerId, taskKind: "connection-test", classification: "synthetic" }),
      ).toEqual({ allowed: false, reason: "no-consent" });
    }
  });

  it("allows the consented classes only, for every task kind, naming destination and version", () => {
    const policy = createEgressPolicy({ db });
    grantAsShown(policy, "codex", ["synthetic"]);
    for (const taskKind of ["extract", "connection-test"] as const) {
      expect(policy.decide({ providerId: "codex", taskKind, classification: "synthetic" })).toEqual(
        {
          allowed: true,
          destination: "vendor:codex",
          policyVersion: policy.policyVersion(),
        },
      );
    }
    expect(
      policy.decide({ providerId: "codex", taskKind: "extract", classification: "general" }),
    ).toEqual({ allowed: false, reason: "no-matching-rule" });
    expect(
      policy.decide({
        providerId: "claude-code",
        taskKind: "extract",
        classification: "synthetic",
      }),
    ).toEqual({ allowed: false, reason: "no-consent" });
  });

  it("keeps a deployment's deny rule in force over the user's consent", () => {
    const policy = createEgressPolicy({
      db,
      siteRules: [rule("deny", "codex", "extract", "synthetic")],
    });
    grantAsShown(policy, "codex", ["synthetic", "general"]);
    expect(
      policy.decide({ providerId: "codex", taskKind: "extract", classification: "synthetic" }),
    ).toEqual({ allowed: false, reason: "rule-denied" });
    expect(
      policy.decide({
        providerId: "codex",
        taskKind: "connection-test",
        classification: "synthetic",
      }),
    ).toMatchObject({ allowed: true });
  });

  it("does not let a site allow rule stand in for consent", () => {
    const policy = createEgressPolicy({ db, siteRules: [rule("allow")] });
    expect(
      policy.decide({ providerId: "codex", taskKind: "extract", classification: "synthetic" }),
    ).toEqual({ allowed: false, reason: "no-consent" });
  });

  it("stops at once when consent is revoked", () => {
    const policy = createEgressPolicy({ db });
    grantAsShown(policy, "codex", ["synthetic"]);
    policy.revoke("codex");
    expect(
      policy.decide({ providerId: "codex", taskKind: "extract", classification: "synthetic" }),
    ).toEqual({ allowed: false, reason: "no-consent" });
  });

  it("rejects invalid site rules at construction (fail closed)", () => {
    expect(() =>
      createEgressPolicy({ db, siteRules: [{ ...rule("allow"), effect: "maybe" } as never] }),
    ).toThrow();
    expect(() =>
      createEgressPolicy({ db, siteRules: [{ ...rule("allow"), note: "x" } as never] }),
    ).toThrow();
  });

  it("treats a stored consent whose classes cannot be read as allowing nothing", () => {
    const policy = createEgressPolicy({ db });
    grantAsShown(policy, "codex", ["synthetic"]);
    db.run("UPDATE consents SET allowed_classes = 'not json' WHERE provider = 'codex'");
    expect(
      policy.decide({ providerId: "codex", taskKind: "extract", classification: "synthetic" }),
    ).toEqual({ allowed: false, reason: "no-matching-rule" });
  });
});

describe("grant binds to what the user was shown", () => {
  it("refuses when the shown destination or policy version is no longer current, storing nothing", () => {
    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://two.synthetic.example/v1");
    const policy = createEgressPolicy({ db });
    const version = policy.policyVersion();
    expect(
      policy.grant("openai-compatible", ["general"], {
        destination: "one.synthetic.example",
        policyVersion: version,
      }),
    ).toEqual({ error: "consent-stale" });
    expect(
      policy.grant("openai-compatible", ["general"], {
        destination: "two.synthetic.example",
        policyVersion: "pv-0000000000000000",
      }),
    ).toEqual({ error: "consent-stale" });
    expect(
      policy.decide({
        providerId: "openai-compatible",
        taskKind: "extract",
        classification: "general",
      }),
    ).toEqual({ allowed: false, reason: "no-consent" });
    expect(
      policy.grant("openai-compatible", ["general"], {
        destination: "two.synthetic.example",
        policyVersion: version,
      }),
    ).toMatchObject({ policyVersion: version });
  });
});

describe("fixed destinations", () => {
  it("do not resolve prototype keys", () => {
    const policy = createEgressPolicy({ db });
    for (const key of ["constructor", "__proto__", "toString"]) {
      expect(policy.destination(key as ProviderId)).toEqual({ problem: "destination-unavailable" });
    }
  });
});

describe("destination of the openai-compatible Provider", () => {
  const decide = (policy: ReturnType<typeof createEgressPolicy>) =>
    policy.decide({
      providerId: "openai-compatible",
      taskKind: "connection-test",
      classification: "synthetic",
    });

  it("is unavailable until an endpoint is set, and consent cannot be given then", () => {
    const policy = createEgressPolicy({ db });
    expect(decide(policy)).toEqual({ allowed: false, reason: "destination-unavailable" });
    expect(
      policy.grant("openai-compatible", ["synthetic"], {
        destination: "api.synthetic.example",
        policyVersion: policy.policyVersion(),
      }),
    ).toEqual({
      error: "destination-unavailable",
    });
  });

  it("is the endpoint's host; an http endpoint is refused unless loopback is allowed", () => {
    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://api.synthetic.example:8443/v1");
    const policy = createEgressPolicy({ db });
    expect(policy.destination("openai-compatible")).toEqual({
      destination: "api.synthetic.example:8443",
    });
    for (const url of ["http://api.synthetic.example/v1", "http://127.0.0.1:9/v1", "ftp://x/"]) {
      writeSetting(db, OPENAI_BASE_URL_SETTING, url);
      expect(policy.destination("openai-compatible")).toEqual({ problem: "insecure-endpoint" });
    }
    writeSetting(db, OPENAI_BASE_URL_SETTING, "not a url");
    expect(policy.destination("openai-compatible")).toEqual({
      problem: "destination-unavailable",
    });

    const testBuild = createEgressPolicy({ db, allowLoopbackHttp: true });
    for (const host of ["127.0.0.1:9", "[::1]:9", "localhost:9"]) {
      writeSetting(db, OPENAI_BASE_URL_SETTING, `http://${host}/v1`);
      expect(testBuild.destination("openai-compatible")).toEqual({ destination: host });
    }
    writeSetting(db, OPENAI_BASE_URL_SETTING, "http://api.synthetic.example/v1");
    expect(testBuild.destination("openai-compatible")).toEqual({ problem: "insecure-endpoint" });
  });

  // URL.host drops user info, so the destination shown for consent would hide the
  // credentials the address carries to that host (T11).
  it.each([
    "https://user:pw@api.synthetic.example/v1",
    "https://user@api.synthetic.example/v1",
    "https://:pw@api.synthetic.example/v1",
  ])("refuses an endpoint carrying user info: %s", (url) => {
    writeSetting(db, OPENAI_BASE_URL_SETTING, url);
    const policy = createEgressPolicy({ db, allowLoopbackHttp: true });
    expect(policy.destination("openai-compatible")).toEqual({ problem: "insecure-endpoint" });
  });
});

describe("parseEndpoint", () => {
  it("is the one parser the policy, the settings API and the Provider share", () => {
    expect(parseEndpoint(undefined, false)).toEqual({ problem: "destination-unavailable" });
    expect(parseEndpoint("not a url", false)).toEqual({ problem: "destination-unavailable" });
    const ok = parseEndpoint("https://api.synthetic.example:8443/v1", false);
    expect("url" in ok && ok.url.host).toBe("api.synthetic.example:8443");
    expect(parseEndpoint("http://127.0.0.1:9/v1", false)).toEqual({
      problem: "insecure-endpoint",
    });
    const loopback = parseEndpoint("http://127.0.0.1:9/v1", true);
    expect("url" in loopback && loopback.url.host).toBe("127.0.0.1:9");
    expect(parseEndpoint("http://user@127.0.0.1:9/v1", true)).toEqual({
      problem: "insecure-endpoint",
    });
  });
});

describe("computePolicyVersion", () => {
  const deny = rule("deny", "codex", "extract", "general");
  const allow = rule("allow", "claude-code");
  const base = [deny, allow];

  it("is stable for the same rules", () => {
    expect(computePolicyVersion(base)).toBe(computePolicyVersion(structuredClone(base)));
  });

  it("changes when any field of any rule changes, or a rule is added or removed", () => {
    const seen = new Set([computePolicyVersion(base)]);
    const variants: EgressRule[][] = [
      [{ ...deny, effect: "allow" }, allow],
      [{ ...deny, provider: "claude-code" }, allow],
      [{ ...deny, taskKind: "connection-test" }, allow],
      [{ ...deny, classification: "synthetic" }, allow],
      [deny],
      [...base, rule("deny")],
      [allow, deny], // order alone: a reordered list asks for consent again (decision 3)
      [],
    ];
    for (const rules of variants) seen.add(computePolicyVersion(rules));
    expect(seen.size).toBe(variants.length + 1);
  });

  it("is what a policy built from those rules reports", () => {
    expect(createEgressPolicy({ db, siteRules: base }).policyVersion()).toBe(
      computePolicyVersion(base),
    );
  });
});

describe("overview for the consent screen", () => {
  it("lists every Provider as external except the local model, with nothing allowed by default", () => {
    const policy = createEgressPolicy({ db });
    const overview = policy.overview();
    expect(overview.policyVersion).toBe(policy.policyVersion());
    expect(overview.classes).toEqual(["synthetic", "general"]);
    expect(overview.providers).toEqual([
      {
        providerId: "claude-code",
        egress: "external",
        destination: "vendor:claude-code",
        destinationProblem: null,
        consent: null,
      },
      {
        providerId: "codex",
        egress: "external",
        destination: "vendor:codex",
        destinationProblem: null,
        consent: null,
      },
      {
        providerId: "openai-compatible",
        egress: "external",
        destination: null,
        destinationProblem: "destination-unavailable",
        consent: null,
      },
      {
        providerId: "local-model",
        egress: "local",
        destination: "local-model",
        destinationProblem: null,
        consent: null,
      },
    ]);
  });

  it("shows a consent as stale when the destination or the policy changed", () => {
    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://one.synthetic.example/v1");
    const policy = createEgressPolicy({ db, now: () => new Date("2026-11-21T00:00:00Z") });
    grantAsShown(policy, "openai-compatible", ["general", "synthetic", "general"]);
    const consentOf = (p: ReturnType<typeof createEgressPolicy>) =>
      p.overview().providers.find((x) => x.providerId === "openai-compatible")?.consent;
    expect(consentOf(policy)).toEqual({
      allowedClasses: ["synthetic", "general"],
      destination: "one.synthetic.example",
      policyVersion: policy.policyVersion(),
      grantedAt: "2026-11-21T00:00:00.000Z",
      state: "valid",
    });
    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://two.synthetic.example/v1");
    expect(consentOf(policy)?.state).toBe("stale-destination");
    writeSetting(db, OPENAI_BASE_URL_SETTING, "https://one.synthetic.example/v1");
    expect(consentOf(createEgressPolicy({ db, siteRules: [rule("deny", "codex")] }))?.state).toBe(
      "stale-policy",
    );
  });
});
