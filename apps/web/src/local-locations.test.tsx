/// <reference types="vite/client" />
// I02B-R36–R38, C52 (screen text): the list shows that normalizing stopped, and the shell's picker path
// approves with the ticket it returns and shows a refusal's text.
import type { LocalLocationList } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "./api.ts";
import { LocationList, pickAndAdd } from "./local-locations.tsx";
import {
  APPROVAL_REJECTION_TEXT,
  NORMALIZER_UNAVAILABLE_TEXT,
  NOT_WATCHING_TEXT,
} from "./local-locations-text.ts";

const list = (over: Partial<LocalLocationList> = {}): LocalLocationList => ({
  locations: [
    {
      id: "a".repeat(22),
      type: "folder",
      displayPath: "/docs",
      state: "active",
      stateReason: null,
      counts: { tracked: 3, skipped: 1, ignored: 2, pendingDeletes: 0 },
      limitExceeded: false,
      lastPassAt: null,
      watching: false,
    },
  ],
  normalizerUnavailable: false,
  limits: {} as LocalLocationList["limits"],
  ...over,
});

describe("the location list", () => {
  it("shows the stopped-normalizer text only when the backend says so, and the no-watching mark (C52)", () => {
    const stopped = renderToStaticMarkup(
      <LocationList list={list({ normalizerUnavailable: true })} />,
    );
    expect(stopped).toContain(NORMALIZER_UNAVAILABLE_TEXT);
    const fine = renderToStaticMarkup(<LocationList list={list()} />);
    expect(fine).not.toContain(NORMALIZER_UNAVAILABLE_TEXT);
    expect(fine).toContain("/docs");
    expect(fine).toContain(NOT_WATCHING_TEXT);
  });
});

describe("the shell's folder picker", () => {
  it("approves with the ticket, never a path; a refusal gives its text; a cancel does nothing", async () => {
    const api = vi.fn(async () => ({}));
    const added = await pickAndAdd(api as unknown as ApiClient, async () => ({
      ticket: "t".repeat(40),
    }));
    expect(added).toEqual({ added: true });
    expect(api).toHaveBeenCalledWith("approveLocalLocation", {
      type: "folder",
      ticket: "t".repeat(40),
    });

    const refusing = vi.fn(async () => {
      throw new ApiError("approval-rejected", 422, "overlaps-location");
    });
    expect(
      await pickAndAdd(refusing as unknown as ApiClient, async () => ({ ticket: "t".repeat(40) })),
    ).toEqual({ added: false, text: APPROVAL_REJECTION_TEXT["overlaps-location"] });

    const untouched = vi.fn();
    expect(
      await pickAndAdd(untouched as unknown as ApiClient, async () => ({ ticket: null })),
    ).toBeUndefined();
    expect(untouched).not.toHaveBeenCalled();
  });
});
