// V01-R7, R18: what a Connector may hand the product, and the exact notice an
// unimplemented site Connector fails with.
import { describe, expect, it } from "vitest";
import {
  ChangeSetSchema,
  CONNECTOR_NOT_IMPLEMENTED,
  ConnectorNotImplementedError,
  SourceRecordSchema,
} from "./connector.ts";

describe("SourceRecordSchema", () => {
  const record = { externalId: "e1", title: "t", body: "b" };

  it("accepts identity, title and body", () => {
    expect(SourceRecordSchema.parse(record)).toEqual(record);
  });

  // A Connector never decides the data class (ADR 0014); a record claiming one is malformed.
  it.each(["classification", "synthetic", "malicious"])("rejects a record carrying %s", (key) => {
    expect(SourceRecordSchema.safeParse({ ...record, [key]: "synthetic" }).success).toBe(false);
  });

  it("rejects an empty external id", () => {
    expect(SourceRecordSchema.safeParse({ ...record, externalId: "" }).success).toBe(false);
  });
});

describe("ChangeSetSchema", () => {
  it("accepts upserts and delete events with a cursor", () => {
    const page = {
      changes: [
        { kind: "upsert", record: { externalId: "e1", title: "t", body: "b" } },
        { kind: "delete", externalId: "e2", version: 2, at: "2026-11-21T00:00:00Z" },
      ],
      nextCursor: "2",
      hasMore: false,
    };
    expect(ChangeSetSchema.parse(page)).toEqual(page);
  });

  it("rejects a page with an unknown field", () => {
    expect(
      ChangeSetSchema.safeParse({ changes: [], nextCursor: "0", hasMore: false, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("ConnectorNotImplementedError", () => {
  it("carries exactly the site follow-up notice", () => {
    expect(CONNECTOR_NOT_IMPLEMENTED).toBe("미구현, 배포처 후속");
    expect(new ConnectorNotImplementedError().message).toBe("미구현, 배포처 후속");
  });
});
