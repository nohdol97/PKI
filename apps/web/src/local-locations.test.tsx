/// <reference types="vite/client" />
// I02B-R36–R38, C52 (screen text): the list shows that normalizing stopped, and the shell's picker path
// approves with the ticket it returns and shows a refusal's text.
import type { LocalLocationList } from "@pki/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "./api.ts";
import { ConfirmDialog } from "./local-location-actions.tsx";
import { LocalLocations, LocationList, pickAndAdd } from "./local-locations.tsx";
import {
  APPROVAL_REJECTION_TEXT,
  NORMALIZER_UNAVAILABLE_TEXT,
  NOT_WATCHING_TEXT,
  REVOKE_WARNING_TEXT,
} from "./local-locations-text.ts";

const list = (over: Partial<LocalLocationList> = {}): LocalLocationList => ({
  locations: [
    {
      id: "a".repeat(22),
      type: "folder",
      displayPath: "/docs",
      state: "active",
      stateReason: null,
      counts: { tracked: 3, skipped: 1, ignored: 2, pendingDeletes: 0, sources: 3 },
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

describe("adding a file (I02B-T06, C34)", () => {
  it("each kind goes to the shell's picker as its own kind and is approved with the ticket", async () => {
    const api = vi.fn(async () => ({}));
    for (const type of ["file", "jsonl-file"] as const) {
      const pick = vi.fn(async () => ({ ticket: "t".repeat(40) }));
      expect(await pickAndAdd(api as unknown as ApiClient, pick, type)).toEqual({ added: true });
      expect(pick).toHaveBeenCalledWith(type);
      expect(api).toHaveBeenLastCalledWith("approveLocalLocation", {
        type,
        ticket: "t".repeat(40),
      });
    }
  });

  it("the Settings section offers 폴더 추가, 파일 추가 and JSONL 파일 추가 as buttons", () => {
    const markup = renderToStaticMarkup(
      <LocalLocations api={vi.fn() as unknown as ApiClient} bridge={{ pickLocation: vi.fn() }} />,
    );
    for (const name of ["폴더 추가", "파일 추가", "JSONL 파일 추가"]) {
      expect(markup).toMatch(new RegExp(`<button[^>]*>${name}</button>`));
    }
  });
});

const withState = (state: LocalLocationList["locations"][number]["state"], pending = 0) =>
  list({
    locations: [
      {
        ...(list().locations[0] as LocalLocationList["locations"][number]),
        state,
        counts: { tracked: 3, skipped: 1, ignored: 2, pendingDeletes: pending, sources: 7 },
      },
    ],
  });

describe("location actions (C28)", () => {
  it("every action is a named button, so the keyboard reaches revocation from the list", () => {
    for (const state of ["active", "paused", "unavailable", "needs-confirmation"] as const) {
      const html = renderToStaticMarkup(<LocationList list={withState(state, 2)} />);
      expect(html).toContain("승인 철회");
      for (const tag of html.match(/<button[^>]*>[^<]*<\/button>/g) ?? []) {
        expect(tag).toContain('type="button"');
        expect(tag).not.toContain("tabindex");
        expect(tag.replace(/<[^>]*>/g, "").length).toBeGreaterThan(0);
      }
    }
    expect(renderToStaticMarkup(<LocationList list={withState("paused")} />)).toContain(
      "다시 켜기",
    );
    expect(
      renderToStaticMarkup(<LocationList list={withState("needs-confirmation", 2)} />),
    ).toContain("삭제 반영");
  });

  it("a revoking row shows the state, the remaining count and a continue button", () => {
    const html = renderToStaticMarkup(<LocationList list={withState("revoking")} />);
    expect(html).toContain("철회하는 중");
    expect(html).toContain("남은 원본 7개");
    expect(html).toContain("철회 계속");
  });

  it("the revoke dialog shows the source count and the fixed sentence", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        title="승인 철회"
        count={7}
        countLabel="지워질 원본"
        warning={REVOKE_WARNING_TEXT}
        confirmLabel="철회"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("지워질 원본 7개");
    expect(html).toContain(
      "이 폴더의 파일은 디스크에 그대로 남습니다. 제품이 가져온 내용과 거기서 나온 지식은 지워지며 되돌릴 수 없습니다",
    );
    expect(html).toContain(">철회</button>");
    expect(html).toContain(">취소</button>");
  });
});
