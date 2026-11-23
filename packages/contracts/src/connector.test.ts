// I01-T01 `source-record.schema` (I01-C2; R1, R4~R7): what a Connector of SDK v2
// may hand the product, and the exact notice an unimplemented site Connector
// fails with (V01-R18). Blocks are the spec's own synthetic ones, not I02 output.
import { describe, expect, it } from "vitest";
import {
  blocksValid,
  ChangeSchema,
  ChangeSetSchema,
  CONNECTOR_KIND_PATTERN,
  CONNECTOR_NOT_IMPLEMENTED,
  CONNECTOR_SDK_VERSION,
  ConnectorError,
  ConnectorNotImplementedError,
  ConnectorRateLimitError,
  EvidenceViewSchema,
  NativeLocatorSchema,
  rejectedPositionValid,
  SourceRecordSchema,
  type NativeLocator,
} from "./connector.ts";

const record = {
  namespace: "",
  externalId: "e1",
  revision: 1,
  schemaVersion: 2,
  title: "t",
  body: "b",
};
const AT = "2026-11-21T00:00:00+09:00";

describe("CONNECTOR_SDK_VERSION", () => {
  it("is 2", () => {
    expect(CONNECTOR_SDK_VERSION).toBe(2);
  });
});

describe("SourceRecordSchema v2 (I01-R5)", () => {
  it("accepts identity, revision, format version and content", () => {
    expect(SourceRecordSchema.parse(record)).toEqual(record);
  });

  it("accepts every optional field", () => {
    const full = {
      ...record,
      namespace: "space-1",
      blocks: [{ start: 0, end: 1, locator: { format: "txt", line: 1 } }],
      accessScope: ["team-a"],
      sourceType: "wiki",
      sourceUrl: "https://wiki.example/p/1",
      author: "놀란 리프",
      participants: ["a", "b"],
      threadId: "th-1",
      createdAt: "2026-11-01T09:00:00Z",
      updatedAt: AT,
      metadata: { k: 1, nested: { x: "y" } },
    };
    expect(SourceRecordSchema.parse(full)).toEqual(full);
  });

  it("takes an empty namespace (the instance has one range) but no empty external id", () => {
    expect(SourceRecordSchema.safeParse({ ...record, namespace: "" }).success).toBe(true);
    expect(SourceRecordSchema.safeParse({ ...record, externalId: "" }).success).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["a string", "1"],
  ])("rejects a revision that is %s", (_, revision) => {
    expect(SourceRecordSchema.safeParse({ ...record, revision }).success).toBe(false);
  });

  // A Connector never decides the data class (ADR 0014) nor names its instance (I01-R5).
  it.each([
    "dataClass",
    "classification",
    "synthetic",
    "malicious",
    "connectorInstanceId",
    "extra",
  ])("rejects a record carrying %s", (key) => {
    expect(SourceRecordSchema.safeParse({ ...record, [key]: "synthetic" }).success).toBe(false);
  });

  it.each([1, 3, "2", undefined])("rejects record schemaVersion %s", (schemaVersion) => {
    expect(SourceRecordSchema.safeParse({ ...record, schemaVersion }).success).toBe(false);
  });

  it("rejects an empty access scope, and a time without a UTC offset", () => {
    expect(SourceRecordSchema.safeParse({ ...record, accessScope: [] }).success).toBe(false);
    expect(SourceRecordSchema.safeParse({ ...record, accessScope: [""] }).success).toBe(false);
    expect(
      SourceRecordSchema.safeParse({ ...record, updatedAt: "2026-11-21T00:00:00" }).success,
    ).toBe(false);
    expect(SourceRecordSchema.safeParse({ ...record, createdAt: "yesterday" }).success).toBe(false);
  });
});

describe("blocks and locators (I01-R7)", () => {
  // One synthetic locator per format of the I02 table; txt and json share a shape.
  const LOCATORS: NativeLocator[] = [
    { format: "pdf", page: 1 },
    {
      format: "docx",
      paragraph: 0,
      style: "Heading 1",
      headingLevel: 1,
      table: { index: 0, row: 0, cell: 0 },
    },
    { format: "docx", paragraph: 2, comment: { thread: 0, index: 1, part: "text" } },
    { format: "xlsx", sheet: "시트1", cell: "B3", row: 3, column: 2 },
    { format: "csv", record: 1, line: 2, field: 1 },
    { format: "html", path: "body>div[1]>p[2]", line: 1 },
    { format: "markdown", line: 1, node: "heading", depth: 2 },
    { format: "txt", line: 1 },
    { format: "json", line: 3 },
  ];

  it.each(LOCATORS.map((l) => [l.format, l] as const))("accepts a %s locator", (_, locator) => {
    expect(NativeLocatorSchema.parse(locator)).toEqual(locator);
  });

  it("accepts the minimal docx and xlsx locators (a sheet-name block has no cell)", () => {
    expect(NativeLocatorSchema.safeParse({ format: "docx", paragraph: 4 }).success).toBe(true);
    expect(NativeLocatorSchema.safeParse({ format: "xlsx", sheet: "s" }).success).toBe(true);
  });

  it.each([
    ["an unknown format", { format: "pptx", slide: 1 }],
    ["a page from 0", { format: "pdf", page: 0 }],
    ["a negative paragraph", { format: "docx", paragraph: -1 }],
    ["a cell outside A1 notation", { format: "xlsx", sheet: "s", cell: "b3" }],
    ["a csv record from 0", { format: "csv", record: 0, line: 1, field: 1 }],
    ["an html locator without a path", { format: "html", line: 1 }],
    ["a markdown locator without a node", { format: "markdown", line: 1 }],
    ["a fractional line", { format: "txt", line: 1.5 }],
    ["another format's field", { format: "pdf", page: 1, sheet: "s" }],
    [
      "a comment part that is neither head nor text",
      { format: "docx", paragraph: 0, comment: { thread: 0, index: 0, part: "x" } },
    ],
  ])("rejects %s", (_, locator) => {
    expect(NativeLocatorSchema.safeParse(locator).success).toBe(false);
  });

  const block = (start: number, end: number) => ({
    start,
    end,
    locator: { format: "txt" as const, line: 1 },
  });

  it("takes sorted, non-overlapping code-point ranges inside the body, gaps allowed", () => {
    expect(blocksValid("abcdef", [block(0, 2), block(3, 6)])).toBe(true);
    expect(blocksValid("abcdef", [block(0, 3), block(3, 6)])).toBe(true);
    expect(blocksValid("abcdef", [])).toBe(true);
  });

  it("counts code points, not UTF-16 units", () => {
    // "😀a" is two code points but three UTF-16 units.
    expect(blocksValid("😀a", [block(0, 2)])).toBe(true);
    expect(blocksValid("😀a", [block(0, 3)])).toBe(false);
  });

  it.each([
    ["an empty range", [block(2, 2)]],
    ["a reversed range", [block(3, 1)]],
    ["a negative start", [block(-1, 1)]],
    ["an end past the body", [block(0, 7)]],
    ["an overlap", [block(0, 3), block(2, 4)]],
    ["an unsorted list", [block(3, 4), block(0, 1)]],
  ])("refuses %s", (_, blocks) => {
    expect(blocksValid("abcdef", blocks)).toBe(false);
  });

  it("checks block fields in the record schema; their ranges are blocksValid's", () => {
    const bad = { ...record, blocks: [{ start: 0, end: 1, locator: { format: "pdf" } }] };
    expect(SourceRecordSchema.safeParse(bad).success).toBe(false);
    const fractional = { ...record, blocks: [{ ...block(0, 1), start: 0.5 }] };
    expect(SourceRecordSchema.safeParse(fractional).success).toBe(false);
  });
});

describe("ChangeSchema (I01-R6)", () => {
  const ref = { namespace: "n", externalId: "e", revision: 2, at: AT };

  it("takes the four kinds", () => {
    for (const change of [
      { kind: "upsert", record },
      { kind: "scope-change", ...ref, accessScope: ["team-b"] },
      { kind: "delete", ...ref },
      { kind: "access-revoked", ...ref },
    ]) {
      expect(ChangeSchema.parse(change)).toEqual(change);
    }
  });

  it("rejects a tombstone carrying content, a v1 `version`, or a missing namespace", () => {
    expect(ChangeSchema.safeParse({ kind: "delete", ...ref, body: "x" }).success).toBe(false);
    const v1 = { kind: "delete", namespace: "n", externalId: "e", version: 2, at: AT };
    expect(ChangeSchema.safeParse(v1).success).toBe(false);
    const noNamespace = { kind: "delete", externalId: "e", revision: 2, at: AT };
    expect(ChangeSchema.safeParse(noNamespace).success).toBe(false);
  });

  // The event time is content-free: only ISO-8601 with a UTC offset (review A-M1).
  it.each(
    ["delete", "access-revoked", "scope-change"].flatMap((kind) =>
      ["x", "2026-11-21T00:00:00", "2026-11-21", "not a time, and not stored", ""].map(
        (at) => [kind, at] as const,
      ),
    ),
  )("rejects a %s event whose at is %j", (kind, at) => {
    const change = { kind, ...ref, at, ...(kind === "scope-change" ? { accessScope: ["t"] } : {}) };
    expect(ChangeSchema.safeParse(change).success).toBe(false);
  });

  it.each(["2026-11-21T00:00:00Z", "2026-11-21T09:00:00.5+09:00", "2026-11-21T00:00:00-05:30"])(
    "takes an event at %s",
    (at) => {
      expect(ChangeSchema.safeParse({ kind: "delete", ...ref, at }).success).toBe(true);
    },
  );

  it("rejects a scope change without a scope (losing all access is access-revoked)", () => {
    expect(ChangeSchema.safeParse({ kind: "scope-change", ...ref }).success).toBe(false);
    expect(ChangeSchema.safeParse({ kind: "scope-change", ...ref, accessScope: [] }).success).toBe(
      false,
    );
  });
});

describe("ChangeSetSchema (I01-R6)", () => {
  it("defaults rejected to an empty list", () => {
    expect(ChangeSetSchema.parse({ changes: [], nextCursor: "0", hasMore: false })).toEqual({
      changes: [],
      nextCursor: "0",
      hasMore: false,
      rejected: [],
    });
  });

  it("carries the Connector's own rejections as position and code", () => {
    const page = {
      changes: [],
      nextCursor: "1",
      hasMore: false,
      rejected: [{ at: "line:12", code: "schema" }],
    };
    expect(ChangeSetSchema.parse(page)).toEqual(page);
    expect(
      ChangeSetSchema.safeParse({ ...page, rejected: [{ at: "line:1", code: "anything" }] })
        .success,
    ).toBe(false);
    expect(
      ChangeSetSchema.safeParse({
        ...page,
        rejected: [{ at: "line:1", code: "schema", detail: "x" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a page with an unknown field", () => {
    expect(
      ChangeSetSchema.safeParse({ changes: [], nextCursor: "0", hasMore: false, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("rejected position (I01-R6)", () => {
  it.each(["line:12", "change:0", "a:1", "record-id:123456789"])("takes %s", (at) => {
    expect(rejectedPositionValid(at)).toBe(true);
  });

  it.each([
    "line",
    "Line:1",
    "1line:1",
    "line:-1",
    "line:1234567890",
    "abcdefghijklmnopq:1",
    "line:12 secret",
    "line: 1",
    "",
  ])("refuses %s", (at) => {
    expect(rejectedPositionValid(at)).toBe(false);
  });
});

describe("Connector errors (I01-R4)", () => {
  it("tell retryable from not, and carry the wait of a rate limit", () => {
    expect(new ConnectorError("x", { retryable: true }).retryable).toBe(true);
    expect(new ConnectorError("x", { retryable: false }).retryable).toBe(false);
    const limited = new ConnectorRateLimitError("slow down", { retryAfterMs: 1500 });
    expect(limited.retryAfterMs).toBe(1500);
    expect(limited).toBeInstanceOf(Error);
    expect([limited.name, new ConnectorError("x", { retryable: true }).name]).toEqual([
      "ConnectorRateLimitError",
      "ConnectorError",
    ]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a rate-limit wait of %s",
    (retryAfterMs) => {
      expect(() => new ConnectorRateLimitError("x", { retryAfterMs })).toThrow(RangeError);
    },
  );
});

describe("EvidenceViewSchema (I01-R29 shape)", () => {
  it("points at a version and a code-point span, with a locator or null", () => {
    const view = {
      sourceVersionId: 3,
      version: 1,
      span: { start: 0, end: 2 },
      quote: "ab",
      locator: { format: "pdf", page: 2 },
    };
    expect(EvidenceViewSchema.parse(view)).toEqual(view);
    expect(EvidenceViewSchema.parse({ ...view, locator: null }).locator).toBeNull();
    expect(EvidenceViewSchema.safeParse({ ...view, locator: undefined }).success).toBe(false);
  });
});

describe("ConnectorNotImplementedError", () => {
  it("carries exactly the site follow-up notice", () => {
    expect(CONNECTOR_NOT_IMPLEMENTED).toBe("미구현, 배포처 후속");
    expect(new ConnectorNotImplementedError().message).toBe("미구현, 배포처 후속");
  });
});

// I05-R7: the one shape of a connector kind name; the tombstone ledger's reader uses the same constant.
describe("CONNECTOR_KIND_PATTERN (I05-R7)", () => {
  it.each(["a", "jsonl-import", "site-mail", "k1", "a".repeat(64)])("accepts %s", (kind) => {
    expect(CONNECTOR_KIND_PATTERN.test(kind)).toBe(true);
  });

  it.each(["", "A", "1a", "-a", "a_b", "a b", "a".repeat(65), "a\n", "é", "a.b"])(
    "refuses %j",
    (kind) => {
      expect(CONNECTOR_KIND_PATTERN.test(kind)).toBe(false);
    },
  );
});
