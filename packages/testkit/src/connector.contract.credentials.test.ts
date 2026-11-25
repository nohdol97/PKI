// I06-T01 `connector.contract.credentials` (I06-C16) and `connector.contract.output-clean`
// (I06-C17): the five credential violation codes each have a double that breaks the
// specification in that one place and is reported with that code alone; a scenario
// without `credentials` and `rejected` runs as it did before; and nothing of the
// scenario's values leaves the check, by its errors (`cause`) or by what it relays
// from `console` and the standard streams. Every value here is made up.
import {
  ConnectorCredentialError,
  ConnectorError,
  HEALTH_REASON_CREDENTIAL_REJECTED,
  type Change,
  type ChangeSet,
  type ConnectorContext,
  type HealthStatus,
  type SourceRecord,
} from "@pki/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_VIOLATION_CODES,
  checkConnector,
  type ConnectorScenario,
} from "./connector.contract.ts";
import { ScriptedConnector, type ScriptEntry } from "./scripted-connector.ts";

// Each has characters whose base64 and percent-encoded shapes differ from the plain one.
const TOKEN = "canary token/é+0123456789";
const WRONG = "wrong token/é+9876543210";

const record = (externalId: string): SourceRecord => ({
  namespace: "",
  externalId,
  revision: 1,
  schemaVersion: 2,
  title: `title of ${externalId}`,
  body: `body of ${externalId}`,
});
const upsert = (r: SourceRecord): Change => ({ kind: "upsert", record: r });
const ENTRIES: ScriptEntry[] = [upsert(record("a")), upsert(record("b"))];
const ORIGIN = { entries: ENTRIES };

const scenario = (patch: Partial<ConnectorScenario> = {}): ConnectorScenario => ({
  config: ORIGIN,
  credentials: { token: TOKEN },
  ...patch,
});
const REJECTED = { config: ORIGIN, credentials: { token: WRONG } };
const withRejected = (): ConnectorScenario => scenario({ rejected: REJECTED });
/** Only the rejected part: no `credentials`, so no other check is on. */
const rejectedOnly: ConnectorScenario = { config: ORIGIN, rejected: REJECTED };

/** The shapes a value may take where the check looks for it (I06-R16). */
const shapes = (value: string) => [
  value,
  Buffer.from(value).toString("base64"),
  encodeURIComponent(value),
];
const hasValue = (text: string, value = TOKEN) => shapes(value).some((s) => text.includes(s));
/** An error as text, down its `cause` chain, with its stack. */
const flat = (error: unknown): string => {
  const parts: string[] = [];
  for (let e = error; ;) {
    if (!(e instanceof Error)) {
      parts.push(String(e));
      return parts.join("\n");
    }
    parts.push(e.name, e.message, e.stack ?? "");
    if (e.cause === undefined) return parts.join("\n");
    e = e.cause;
  }
};

/** An error whose stack holds `text` and whose message no longer does (the stack is fixed once read). */
const withOnlyStack = (text: string) => {
  const error = new Error(text);
  void error.stack;
  error.message = "refused";
  return error;
};

/** A scripted Connector that keeps the token it read at initialize and answers nothing before it. */
class Holding extends ScriptedConnector {
  token = "";
  override async initialize(config: unknown, context?: ConnectorContext) {
    await super.initialize(config, context);
    this.token = (await context?.credentials.read("token")) ?? "";
  }
}

const leaksInRecord = (form: (token: string) => string) =>
  class extends Holding {
    override async getChanges(
      cursor: string | null,
      opts: { limit: number; signal: AbortSignal },
    ): Promise<ChangeSet> {
      const page = await super.getChanges(cursor, opts);
      return {
        ...page,
        changes: page.changes.map((c) =>
          c.kind === "upsert"
            ? { ...c, record: { ...c.record, metadata: { echo: form(this.token) } } }
            : c,
        ),
      };
    }
    override async getDocument(ref: { namespace: string; externalId: string }) {
      const doc = await super.getDocument(ref);
      return doc && { ...doc, metadata: { echo: form(this.token) } };
    }
  };

/** Throws what `make` builds from the token when asked with an already cancelled signal. */
const failsAbortedWith = (make: (token: string) => unknown) =>
  class extends Holding {
    override async getChanges(
      cursor: string | null,
      opts: { limit: number; signal: AbortSignal },
    ): Promise<ChangeSet> {
      if (opts.signal.aborted) throw make(this.token);
      return super.getChanges(cursor, opts);
    }
  };

/**
 * A Connector for the rejected scenario: given WRONG instead of TOKEN, `refuse` decides what
 * its initialize does, and `health` is what it then answers to a health check.
 */
const refusing = (
  refuse: () => Promise<void>,
  health?: HealthStatus,
  answerWhenWrong?: (wrong: string) => ChangeSet,
) =>
  class extends ScriptedConnector {
    protected wrong = false;
    override async initialize(config: unknown, context?: ConnectorContext) {
      await super.initialize(config, context);
      this.wrong = (await context?.credentials.read("token")) === WRONG;
      if (this.wrong) await refuse();
    }
    override async healthCheck() {
      return this.wrong && health ? health : super.healthCheck();
    }
    override async getChanges(
      cursor: string | null,
      opts: { limit: number; signal: AbortSignal },
    ): Promise<ChangeSet> {
      return this.wrong && answerWhenWrong
        ? answerWhenWrong(WRONG)
        : super.getChanges(cursor, opts);
    }
  };

const log = (text: string) => process.stdout.write(`${text}\n`);

describe("connector.contract.credentials", () => {
  it("names the five credential codes after the twenty-one of I01-R25, in I06-R21's order, then the two session codes (I06S-R12)", () => {
    expect(CONNECTOR_VIOLATION_CODES.slice(21)).toEqual([
      "credential-in-record",
      "credential-in-health",
      "credential-in-error",
      "credential-in-log",
      "credential-rejection-unsignalled",
      "rotated-credential-leaked",
      "session-not-persisted",
    ]);
    expect(CONNECTOR_VIOLATION_CODES).toHaveLength(28);
  });

  it("finds nothing wrong with a Connector that reads its credentials and leaks none", async () => {
    expect(await checkConnector(() => new Holding(), withRejected())).toEqual([
      "credential-rejection-unsignalled",
    ]);
    const signalled = refusing(async () => {
      throw new ConnectorCredentialError();
    });
    expect(await checkConnector(() => new signalled(), withRejected())).toEqual([]);
  });

  describe("credential-in-record", () => {
    it.each([
      ["as it is", (t: string) => t],
      ["in base64", (t: string) => Buffer.from(t).toString("base64")],
      ["percent-encoded", (t: string) => encodeURIComponent(t)],
      ["inside a longer text", (t: string) => `prefix ${t} suffix`],
    ])("is reported alone when a record carries the value %s", async (_name, form) => {
      const Leaky = leaksInRecord(form);
      expect(await checkConnector(() => new Leaky(), scenario())).toEqual(["credential-in-record"]);
    });

    it("is reported when only getDocument returns the value", async () => {
      class Doc extends Holding {
        override async getDocument(ref: { namespace: string; externalId: string }) {
          const doc = await super.getDocument(ref);
          return doc && { ...doc, metadata: { echo: this.token } };
        }
      }
      const codes = await checkConnector(() => new Doc(), scenario());
      expect(codes).toContain("credential-in-record");
    });

    it("is reported when only the pages of getChanges carry the value", async () => {
      class PagesOnly extends Holding {
        override async getChanges(
          cursor: string | null,
          opts: { limit: number; signal: AbortSignal },
        ): Promise<ChangeSet> {
          const page = await super.getChanges(cursor, opts);
          const echo = (c: Change): Change =>
            c.kind === "upsert"
              ? { ...c, record: { ...c.record, metadata: { echo: this.token } } }
              : c;
          return { ...page, changes: page.changes.map(echo) };
        }
      }
      // getDocument then differs from what was delivered, which is its own violation
      expect(await checkConnector(() => new PagesOnly(), scenario())).toEqual([
        "get-document-mismatch",
        "credential-in-record",
      ]);
    });

    it("does not let a revoked Proxy in a returned page escape as a TypeError, and counts it as holding", async () => {
      class Revoked extends Holding {
        override async getChanges(
          cursor: string | null,
          opts: { limit: number; signal: AbortSignal },
        ): Promise<ChangeSet> {
          const { proxy, revoke } = Proxy.revocable({}, {});
          revoke();
          return { ...(await super.getChanges(cursor, opts)), unread: proxy } as ChangeSet;
        }
      }
      const codes = await checkConnector(() => new Revoked(), scenario());
      expect(codes).toContain("credential-in-record");
    });

    it("is not looked for when the scenario has no credentials", async () => {
      const Leaky = leaksInRecord((t) => t);
      expect(await checkConnector(() => new Leaky(), { config: ORIGIN })).toEqual([]);
    });
  });

  describe("credential-in-health", () => {
    it("is reported alone when the health answer carries the value", async () => {
      class Leaky extends Holding {
        override async healthCheck() {
          return { state: "ok", note: this.token } as HealthStatus;
        }
      }
      expect(await checkConnector(() => new Leaky(), scenario())).toEqual(["credential-in-health"]);
    });
  });

  describe("credential-in-error", () => {
    it.each<[string, (token: string) => unknown]>([
      ["its message", (t) => new Error(`refused ${t}`)],
      [
        "its name",
        (t) => Object.assign(new Error("refused"), { name: `Refused${encodeURIComponent(t)}` }),
      ],
      ["a field it lists", (t) => Object.assign(new Error("refused"), { detail: { t } })],
      [
        "its cause chain",
        (t) => new Error("refused", { cause: new Error("because", { cause: t }) }),
      ],
      ["a thrown text", (t) => `refused ${Buffer.from(t).toString("base64")}`],
      ["its stack alone, the message having been replaced", (t) => withOnlyStack(`refused ${t}`)],
      [
        "a field under a symbol key",
        (t) => Object.assign(new Error("refused"), { [Symbol("k")]: t }),
      ],
    ])(
      "is reported alone when the cancelled-call error carries the value in %s",
      async (_n, make) => {
        const Leaky = failsAbortedWith(make);
        expect(await checkConnector(() => new Leaky(), scenario())).toEqual([
          "credential-in-error",
        ]);
      },
    );

    it.each(["getChanges", "getDocument"] as const)(
      "is reported when the error of an answer asked before initialize carries the value (%s)",
      async (method) => {
        class Early extends Holding {
          override async getChanges(
            cursor: string | null,
            opts: { limit: number; signal: AbortSignal },
          ) {
            if (method === "getChanges" && !this.token) throw new Error(`not ready ${TOKEN}`);
            return super.getChanges(cursor, opts);
          }
          override async getDocument(ref: { namespace: string; externalId: string }) {
            if (method === "getDocument" && !this.token) throw new Error(`not ready ${TOKEN}`);
            return super.getDocument(ref);
          }
        }
        expect(await checkConnector(() => new Early(), scenario())).toEqual([
          "credential-in-error",
        ]);
      },
    );

    it("is reported when the error of the rejected scenario carries a rejected value", async () => {
      const Leaky = refusing(async () => {
        throw Object.assign(new ConnectorCredentialError(), { cause: new Error(WRONG) });
      });
      expect(await checkConnector(() => new Leaky(), rejectedOnly)).toEqual([
        "credential-in-error",
      ]);
    });

    it("reports a thrown Proxy whose key listing throws with the value in the trap's own error, as a code", async () => {
      const Hostile = failsAbortedWith(
        (t) =>
          new Proxy(new Error("refused"), {
            ownKeys() {
              throw new Error(`trap ${t}`);
            },
          }),
      );
      expect(await checkConnector(() => new Hostile(), scenario())).toEqual([
        "credential-in-error",
      ]);
    });

    it("is not reported for errors that carry no value", async () => {
      const Clean = failsAbortedWith(() => new ConnectorError("refused", { retryable: false }));
      expect(await checkConnector(() => new Clean(), scenario())).toEqual([]);
    });
  });

  describe("credential-in-log", () => {
    it.each<[string, (token: string) => void]>([
      ["console.log", (t) => console.log("connected with", t)],
      ["console.error with an object", (t) => console.error("failed", { auth: { t } })],
      ["console.warn in base64", (t) => console.warn(Buffer.from(t).toString("base64"))],
      ["console.info percent-encoded", (t) => console.info(encodeURIComponent(t))],
      ["process.stdout.write", (t) => log(t)],
      ["process.stderr.write of bytes", (t) => process.stderr.write(Buffer.from(`${t}\n`))],
    ])("is reported alone when initialize writes the value with %s", async (_name, write) => {
      class Chatty extends Holding {
        override async initialize(config: unknown, context?: ConnectorContext) {
          await super.initialize(config, context);
          write(this.token);
        }
      }
      expect(await checkConnector(() => new Chatty(), scenario())).toEqual(["credential-in-log"]);
    });

    it("is reported for a write a timer makes after the call that scheduled it answered", async () => {
      class Late extends Holding {
        override async getChanges(
          cursor: string | null,
          opts: { limit: number; signal: AbortSignal },
        ) {
          if (opts.signal.aborted) setTimeout(() => console.log(this.token), 0);
          return super.getChanges(cursor, opts);
        }
      }
      expect(await checkConnector(() => new Late(), scenario())).toEqual(["credential-in-log"]);
    });

    it("is reported when the write comes from the rejected scenario's Connector", async () => {
      const Chatty = refusing(async () => {
        console.log(WRONG);
        throw new ConnectorCredentialError();
      });
      expect(await checkConnector(() => new Chatty(), rejectedOnly)).toEqual(["credential-in-log"]);
    });
  });

  describe("credential-rejection-unsignalled", () => {
    it.each<[string, new () => ScriptedConnector, boolean]>([
      [
        "initialize throws a plain ConnectorError",
        refusing(async () => {
          throw new ConnectorError("401", { retryable: false });
        }),
        true,
      ],
      [
        "initialize answers and getChanges throws a plain ConnectorError",
        class extends refusing(async () => undefined) {
          override async getChanges(
            cursor: string | null,
            opts: { limit: number; signal: AbortSignal },
          ): Promise<ChangeSet> {
            if (this.wrong) throw new ConnectorError("401", { retryable: false });
            return super.getChanges(cursor, opts);
          }
        },
        true,
      ],
      [
        "only healthCheck says the credential was rejected",
        class extends refusing(async () => undefined, {
          state: "unavailable",
          reason: HEALTH_REASON_CREDENTIAL_REJECTED,
        }) {},
        true,
      ],
      ["the wrong value is accepted", refusing(async () => undefined), true],
      [
        "initialize throws ConnectorCredentialError",
        refusing(async () => {
          throw new ConnectorCredentialError();
        }),
        false,
      ],
      [
        "initialize answers and the first getChanges throws ConnectorCredentialError",
        class extends refusing(async () => undefined) {
          override async getChanges(
            cursor: string | null,
            opts: { limit: number; signal: AbortSignal },
          ): Promise<ChangeSet> {
            if (this.wrong) throw new ConnectorCredentialError();
            return super.getChanges(cursor, opts);
          }
        },
        false,
      ],
    ])("%s", async (_name, Subject, reported) => {
      // The ordinary read of the made-up origin passes with TOKEN, so only the rejection speaks.
      expect(await checkConnector(() => new Subject(), withRejected())).toEqual(
        reported ? ["credential-rejection-unsignalled"] : [],
      );
    });

    /** Answers the rejected scenario's first read with what `answer` builds from WRONG. */
    const answeringRejected = (answer: (wrong: string) => ChangeSet) =>
      refusing(async () => undefined, undefined, answer);

    it("scans the page the rejected instance's getChanges returns, and only that page leaks", async () => {
      const Leaky = answeringRejected((wrong) => ({
        changes: [upsert({ ...record("a"), metadata: { echo: wrong } })],
        nextCursor: "offset:1",
        hasMore: false,
      }));
      expect(await checkConnector(() => new Leaky(), rejectedOnly)).toEqual([
        "credential-in-record",
        "credential-rejection-unsignalled",
      ]);
    });

    it("scans the cursor of the page the rejected instance's getChanges returns", async () => {
      const Leaky = answeringRejected((wrong) => ({
        changes: [],
        nextCursor: wrong,
        hasMore: false,
      }));
      expect(await checkConnector(() => new Leaky(), rejectedOnly)).toEqual([
        "credential-in-record",
        "credential-rejection-unsignalled",
      ]);
    });

    it("scans the error the rejected instance's getChanges throws", async () => {
      const Leaky = class extends refusing(async () => undefined) {
        override async getChanges(
          cursor: string | null,
          opts: { limit: number; signal: AbortSignal },
        ): Promise<ChangeSet> {
          if (this.wrong) {
            throw Object.assign(new ConnectorCredentialError(), { cause: new Error(WRONG) });
          }
          return super.getChanges(cursor, opts);
        }
      };
      expect(await checkConnector(() => new Leaky(), rejectedOnly)).toEqual([
        "credential-in-error",
      ]);
    });

    it("is not looked for when the scenario has no rejected part", async () => {
      expect(await checkConnector(() => new Holding(), scenario())).toEqual([]);
    });
  });

  describe("a scenario without credentials and rejected", () => {
    it("hands initialize one argument and leaves console and the streams alone", async () => {
      const original = {
        log: console.log,
        error: console.error,
        out: process.stdout.write,
        err: process.stderr.write,
      };
      const arities: number[] = [];
      const taps: boolean[] = [];
      class Plain extends ScriptedConnector {
        override async initialize(...args: [unknown, ConnectorContext?]) {
          arities.push(args.length);
          return super.initialize(...args);
        }
        override async getChanges(
          cursor: string | null,
          opts: { limit: number; signal: AbortSignal },
        ) {
          taps.push(
            console.log === original.log &&
              console.error === original.error &&
              process.stdout.write === original.out &&
              process.stderr.write === original.err,
          );
          return super.getChanges(cursor, opts);
        }
      }
      expect(await checkConnector(() => new Plain(), { config: ORIGIN, later: ORIGIN })).toEqual(
        [],
      );
      expect(new Set(arities)).toEqual(new Set([1]));
      expect(taps.length).toBeGreaterThan(0);
      expect(new Set(taps)).toEqual(new Set([true]));
    });

    it("looks at no error at all: a cancelled-call error that throws when its keys are listed changes nothing", async () => {
      const Hostile = failsAbortedWith(
        () =>
          new Proxy(new Error("refused"), {
            ownKeys() {
              throw new Error("keys that cannot be listed");
            },
          }),
      );
      expect(await checkConnector(() => new Hostile(), { config: ORIGIN })).toEqual([]);
    });
  });

  describe("the accessor handed to initialize", () => {
    it("reads the scenario's value for its slot, refuses another slot, and goes to every instance it initializes", async () => {
      const given: (ConnectorContext | undefined)[] = [];
      const origin = {
        entries: ENTRIES,
        onInitialize: (c?: ConnectorContext) => void given.push(c),
      };
      const rejectedOrigin = { ...origin };
      await checkConnector(() => new ScriptedConnector(), {
        config: origin,
        later: origin,
        credentials: { token: TOKEN },
        rejected: { config: rejectedOrigin, credentials: { token: WRONG } },
      });
      // the subject, the later config's instance, the rejected scenario's instance
      expect(given).toHaveLength(3);
      for (const context of given) expect(context).toBeDefined();
      expect(await given[0]?.credentials.read("token")).toBe(TOKEN);
      expect(await given[1]?.credentials.read("token")).toBe(TOKEN);
      expect(await given[2]?.credentials.read("token")).toBe(WRONG);
      await expect(given[0]?.credentials.read("other")).rejects.toBeInstanceOf(
        ConnectorCredentialError,
      );
    });
  });

  describe("scenario values", () => {
    it.each([
      ["credentials", (v: string): Partial<ConnectorScenario> => ({ credentials: { token: v } })],
      [
        "rejected.credentials",
        (v: string): Partial<ConnectorScenario> => ({
          rejected: { config: ORIGIN, credentials: { token: v } },
        }),
      ],
    ])(
      "a %s value shorter than 16 characters is a scenario error that does not repeat it",
      async (_n, patch) => {
        const short = "fifteen-chars-x!";
        expect(short).toHaveLength(16);
        const tooShort = short.slice(1);
        const failure = await checkConnector(() => new ScriptedConnector(), {
          config: ORIGIN,
          ...patch(tooShort),
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect(flat(failure)).not.toContain(tooShort);
        // 16 characters is the least that is allowed
        const codes = await checkConnector(() => new ScriptedConnector(), {
          config: ORIGIN,
          ...patch(short),
        });
        expect(Array.isArray(codes)).toBe(true);
      },
    );
  });
});

describe("connector.contract.output-clean", () => {
  /** What a failed check throws, as text. */
  const failureText = async (create: () => ScriptedConnector, s: ConnectorScenario) => {
    const failure = await checkConnector(create, s).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    return flat(failure);
  };

  it("does not repeat a value of the scenario from an initialize failure, by message, cause or stack", async () => {
    class Fails extends ScriptedConnector {
      override async initialize(): Promise<void> {
        throw new Error(`origin said ${TOKEN}`, { cause: new Error(TOKEN) });
      }
    }
    const text = await failureText(() => new Fails(), scenario());
    expect(text).toContain("did not initialize");
    expect(hasValue(text)).toBe(false);
  });

  it("does not repeat a value from the failure of the later config's initialize", async () => {
    class FailsLater extends ScriptedConnector {
      override async initialize(config: unknown, context?: ConnectorContext) {
        if ((config as { boom?: boolean }).boom) throw new Error(`origin said ${TOKEN}`);
        return super.initialize(config, context);
      }
    }
    const text = await failureText(() => new FailsLater(), scenario({ later: { boom: true } }));
    expect(text).toContain("later config");
    expect(hasValue(text)).toBe(false);
  });

  it("does not repeat a value from a getChanges failure in the middle of a read", async () => {
    const text = await failureText(
      () => new ScriptedConnector(),
      scenario({
        config: {
          entries: ENTRIES,
          pageSize: 1,
          faults: [{ cursor: "offset:1", raise: new Error(`origin said ${TOKEN}`) }],
        },
      }),
    );
    expect(text).toContain("getChanges failed");
    expect(hasValue(text)).toBe(false);
  });

  it.each<[string, (token: string) => Error]>([
    ["its stack alone", (t) => withOnlyStack(`origin said ${t}`)],
    ["a symbol-keyed field", (t) => Object.assign(new Error("origin"), { [Symbol("k")]: t })],
  ])(
    "attaches no cause at any of the three sites when the error holds the value in %s",
    async (_n, make) => {
      class Fails extends ScriptedConnector {
        override async initialize(config: unknown, context?: ConnectorContext) {
          const boom = (config as { boom?: string }).boom;
          if (boom) throw make(TOKEN);
          return super.initialize(config, context);
        }
      }
      const first = scenario({ config: { boom: "first" } });
      const later = scenario({ later: { boom: "later" } });
      const mid = scenario({
        config: {
          entries: ENTRIES,
          pageSize: 1,
          faults: [{ cursor: "offset:1", raise: make(TOKEN) }],
        },
      });
      for (const s of [first, later, mid]) {
        const failure = await checkConnector(() => new Fails(), s).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).cause).toBeUndefined();
      }
    },
  );

  it("attaches no cause when the error is a Proxy that cannot be read, and the trap's error is not repeated", async () => {
    class Fails extends ScriptedConnector {
      override async initialize(): Promise<void> {
        throw new Proxy(new Error("refused"), {
          ownKeys() {
            throw new Error(`trap ${TOKEN}`);
          },
        });
      }
    }
    const failure = await checkConnector(() => new Fails(), scenario()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBeUndefined();
    expect(hasValue(flat(failure))).toBe(false);
  });

  it("keeps the cause of a failure that holds no value", async () => {
    const cause = new ConnectorError("origin down", { retryable: true });
    const text = await failureText(
      () => new ScriptedConnector(),
      scenario({
        config: { entries: ENTRIES, pageSize: 1, faults: [{ cursor: "offset:1", raise: cause }] },
      }),
    );
    expect(text).toContain("origin down");
  });

  describe("what the check relays from console and the standard streams", () => {
    const FUNCTIONS = ["log", "info", "warn", "error", "debug"] as const;

    /** Runs `run` with recorders on console and both streams; nothing real is written. */
    async function recording(run: () => Promise<unknown>) {
      const kept = FUNCTIONS.map((name) => [name, console[name]] as const);
      const out = process.stdout.write;
      const err = process.stderr.write;
      const heard: string[] = [];
      for (const name of FUNCTIONS)
        console[name] = (...args: unknown[]) => void heard.push(args.map(String).join(" "));
      const stream = ((c: unknown) => (heard.push(String(c)), true)) as typeof process.stdout.write;
      process.stdout.write = stream;
      process.stderr.write = stream;
      try {
        await run();
        // Let a timer scheduled during the run fire while the recorders are still on.
        await new Promise((resolve) => setTimeout(resolve, 5));
      } finally {
        for (const [name, fn] of kept) console[name] = fn;
        process.stdout.write = out;
        process.stderr.write = err;
      }
      return heard;
    }

    /** Writes the token every way the check watches. */
    class Leaks extends Holding {
      override async initialize(config: unknown, context?: ConnectorContext) {
        await super.initialize(config, context);
        console.log(this.token);
        console.error({ deep: { deeper: { deepest: { token: this.token } } } });
        log(this.token);
        process.stderr.write(this.token);
      }
    }
    class Chatty extends Leaks {
      override async initialize(config: unknown, context?: ConnectorContext) {
        await super.initialize(config, context);
        console.log("harmless console line");
        log("harmless stream line");
      }
    }

    it("holds back every text that carries a value and passes the rest on to where it was going", async () => {
      const heard = await recording(async () => {
        expect(await checkConnector(() => new Chatty(), scenario())).toEqual(["credential-in-log"]);
      });
      expect(heard).toEqual(["harmless console line", "harmless stream line\n"]);
    });

    it("puts console and both streams back as they were, also when the check throws", async () => {
      class Throws extends Leaks {
        override async getChanges(): Promise<ChangeSet> {
          throw new Error("boom");
        }
      }
      const before = FUNCTIONS.map((name) => console[name]);
      const out = process.stdout.write;
      const err = process.stderr.write;
      await expect(checkConnector(() => new Throws(), scenario())).rejects.toThrow();
      expect(FUNCTIONS.map((name) => console[name])).toEqual(before);
      expect(process.stdout.write).toBe(out);
      expect(process.stderr.write).toBe(err);
    });

    it("puts them back as they were when two checks overlap, and each still sees its own leak", async () => {
      const before = FUNCTIONS.map((name) => console[name]);
      const out = process.stdout.write;
      const err = process.stderr.write;
      const [first, second] = await Promise.all([
        checkConnector(() => new Leaks(), scenario()),
        checkConnector(() => new Leaks(), scenario()),
      ]);
      expect(first).toEqual(["credential-in-log"]);
      expect(second).toEqual(["credential-in-log"]);
      expect(FUNCTIONS.map((name) => console[name])).toEqual(before);
      expect(process.stdout.write).toBe(out);
      expect(process.stderr.write).toBe(err);
    });

    it("gives up a check that never settles within its deadline, with no value in the error, and puts everything back", async () => {
      class Hangs extends ScriptedConnector {
        override async initialize(): Promise<void> {
          await new Promise(() => undefined);
        }
      }
      const before = FUNCTIONS.map((name) => console[name]);
      const out = process.stdout.write;
      const err = process.stderr.write;
      const text = await failureText(() => new Hangs(), scenario());
      expect(text).toContain("deadline");
      expect(hasValue(text)).toBe(false);
      expect(FUNCTIONS.map((name) => console[name])).toEqual(before);
      expect(process.stdout.write).toBe(out);
      expect(process.stderr.write).toBe(err);
      // the queue is released: a credentialed check that follows still runs
      expect(await checkConnector(() => new Holding(), scenario())).toEqual([]);
    }, 15_000);

    it("does not let a logged object with a throwing getter make console.log throw", async () => {
      class Hostile extends Holding {
        override async initialize(config: unknown, context?: ConnectorContext) {
          await super.initialize(config, context);
          console.log({
            get boom(): string {
              throw new Error("a getter that throws");
            },
          });
        }
      }
      const heard = await recording(async () => {
        expect(await checkConnector(() => new Hostile(), scenario())).toEqual([]);
      });
      expect(heard).toHaveLength(1);
    });

    /** Initializes, then logs what `build` makes of the token. */
    const logging = (build: (token: string) => unknown[]) =>
      class extends Holding {
        override async initialize(config: unknown, context?: ConnectorContext) {
          await super.initialize(config, context);
          console.log(...build(this.token));
        }
      };
    const unreadable = () =>
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("keys that cannot be listed");
          },
        },
      );

    it("does not let a logged Proxy whose key listing throws make console.log throw", async () => {
      const Chatty = logging(() => [unreadable()]);
      const heard = await recording(async () => {
        expect(await checkConnector(() => new Chatty(), scenario())).toEqual([]);
      });
      expect(heard).toHaveLength(1);
    });

    it("does not let a logged object nested too deep to walk make console.log throw", async () => {
      const Chatty = logging(() => {
        let deep: Record<string, unknown> = {};
        for (let i = 0; i < 100_000; i++) deep = { deep };
        return [deep];
      });
      const heard = await recording(async () => {
        expect(await checkConnector(() => new Chatty(), scenario())).toEqual([]);
      });
      expect(heard).toHaveLength(1);
    });

    it("still scans the other arguments when one cannot be read", async () => {
      const Chatty = logging((token) => [unreadable(), "later argument", token]);
      expect(await checkConnector(() => new Chatty(), scenario())).toEqual(["credential-in-log"]);
    });

    it("leaves no deadline timer pending once a check completes", async () => {
      const set = vi.spyOn(globalThis, "setTimeout");
      const clear = vi.spyOn(globalThis, "clearTimeout");
      try {
        expect(await checkConnector(() => new Holding(), scenario())).toEqual([]);
        const index = set.mock.calls.findIndex(([, delay]) => delay === 4000);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(clear).toHaveBeenCalledWith(set.mock.results[index]?.value);
      } finally {
        set.mockRestore();
        clear.mockRestore();
      }
    });

    it("still catches a value that only the formatted text holds, next to such an object", async () => {
      class Hostile extends Holding {
        override async initialize(config: unknown, context?: ConnectorContext) {
          await super.initialize(config, context);
          console.log("%s", {
            toString: () => this.token,
            get boom(): string {
              throw new Error("a getter that throws");
            },
          });
        }
      }
      expect(await checkConnector(() => new Hostile(), scenario())).toEqual(["credential-in-log"]);
    });

    it("hands back only codes, so a failure report built from the result carries no value", async () => {
      const Leaky = leaksInRecord((t) => t);
      const codes = await checkConnector(() => new Leaky(), scenario());
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes)
        expect(CONNECTOR_VIOLATION_CODES as readonly string[]).toContain(code);
      expect(hasValue(JSON.stringify(codes))).toBe(false);
    });
  });
});

// I06S-C5 (suite side; R12): a scenario with `login` gives the Connector a `write` on the session slot, looks
// for what it wrote like the scenario's own values, and asks a new instance whether the session was kept.
describe("connector.contract.session (I06S-R12)", () => {
  const FIRST = "first session/é+0123456789";
  const ROTATED = "rotated session/é+abcdefghij";

  /**
   * A made-up origin whose session token rotates: every request is answered with a new one and the old
   * one is refused from then on. `behaviour` decides what a Connector does with the new token.
   */
  function origin(behaviour: { write: boolean; leakTo?: (value: string) => void }) {
    let valid = FIRST;
    let counter = 0;
    class Rotating extends ScriptedConnector {
      private context: ConnectorContext | undefined;
      /** The token this object holds in memory: what a Connector that does not write back lives on. */
      private token = "";
      override async initialize(config: unknown, context?: ConnectorContext) {
        await super.initialize(config, context);
        this.context = context;
        this.token = (await context?.credentials.read("session")) as string;
        await this.request();
      }
      /** One request to the origin: the held token must be the valid one; the answer carries the next. */
      private async request() {
        if (this.token !== valid) throw new ConnectorCredentialError();
        valid = counter++ === 0 ? ROTATED : `${ROTATED}-${counter}`;
        this.token = valid;
        behaviour.leakTo?.(valid);
        if (behaviour.write) await this.context?.credentials.write?.("session", valid);
      }
      override async getChanges(
        cursor: string | null,
        opts: { limit: number; signal: AbortSignal },
      ): Promise<ChangeSet> {
        await this.request();
        return super.getChanges(cursor, opts);
      }
      echo() {
        return this.token;
      }
    }
    return Rotating;
  }
  const login = (patch: Partial<ConnectorScenario> = {}): ConnectorScenario => ({
    config: ORIGIN,
    credentials: { session: FIRST },
    login: "session",
    ...patch,
  });

  it("a Connector that writes every rotated token back has no violation", async () => {
    const Good = origin({ write: true });
    expect(await checkConnector(() => new Good(), login())).toEqual([]);
  });

  it("a Connector that never writes the rotated token back is session-not-persisted", async () => {
    const Lazy = origin({ write: false });
    expect(await checkConnector(() => new Lazy(), login())).toEqual(["session-not-persisted"]);
  });

  it("a Connector that prints a value it wrote is rotated-credential-leaked, and the value never leaves the check", async () => {
    const Loud = origin({ write: true, leakTo: (value) => console.log(`token is ${value}`) });
    const seen: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      seen.push(String(chunk));
      return true;
    });
    try {
      expect(await checkConnector(() => new Loud(), login())).toEqual([
        "rotated-credential-leaked",
      ]);
    } finally {
      out.mockRestore();
    }
    expect(seen.join("")).not.toContain(ROTATED);
  });

  it("a Connector that throws or returns a value it wrote is rotated-credential-leaked too", async () => {
    class Echo extends origin({ write: true }) {
      override async getDocument(ref: { namespace: string; externalId: string }) {
        const doc = await super.getDocument(ref);
        const written = await (
          this as unknown as { context: ConnectorContext }
        ).context.credentials.read("session");
        return doc && { ...doc, metadata: { echo: written } };
      }
    }
    expect(await checkConnector(() => new Echo(), login())).toContain("rotated-credential-leaked");
  });

  it("a scenario without login runs as before: a write is not offered and nothing is looked for", async () => {
    let offered: boolean | undefined;
    class Probe extends ScriptedConnector {
      override async initialize(config: unknown, context?: ConnectorContext) {
        await super.initialize(config, context);
        offered = context?.credentials.write !== undefined;
      }
    }
    expect(await checkConnector(() => new Probe(), scenario())).toEqual([]);
    expect(offered).toBe(false);
  });

  it("the session accessor writes the session slot only and refuses a value the product would refuse", async () => {
    const refusals: unknown[] = [];
    class Writer extends ScriptedConnector {
      override async initialize(config: unknown, context?: ConnectorContext) {
        await super.initialize(config, context);
        for (const [slot, value] of [
          ["other", "x".repeat(20)],
          ["session", "line1\nline2"],
          ["session", ""],
        ] as const) {
          await context?.credentials.write?.(slot, value).catch((e: unknown) => refusals.push(e));
        }
      }
    }
    const both = { session: FIRST, other: "other token/é+0123456789" };
    await checkConnector(() => new Writer(), login({ credentials: both }));
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    expect(refusals.every((e) => e instanceof ConnectorCredentialError)).toBe(true);
  });

  it("a login that is not one of the credentials is a scenario error", async () => {
    await expect(
      checkConnector(() => new ScriptedConnector(), login({ login: "nope" })),
    ).rejects.toThrow("login must name one of its credentials");
  });
});
