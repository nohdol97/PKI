// Settings' "로컬 자료" section (I02B-R36, R37, R38): the approved locations and the ways to add one: a folder,
// a document file ("파일 추가") and a JSONL file ("JSONL 파일 추가", I02B-R41).
// In the Electron shell a button opens the OS picker through the preload and approves with the one-time
// ticket it returns; the page never holds the path. In browser development (Vite dev server) a labelled input
// takes a typed absolute path instead; the branch tests the compile-time `import.meta.env.DEV`,
// so the production build drops it and its label (bundle check: apps/desktop/e2e/build-web.setup.ts).
import type {
  LocalApprovalRejectionCode,
  LocalLocationInfo,
  LocalLocationList,
  LocalSkippedResponse,
} from "@pki/contracts";
import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import {
  ConfirmDialog,
  LocationActions,
  SkippedList,
  type LocationAction,
} from "./local-location-actions.tsx";
import {
  ACTION_REFUSAL_TEXT,
  APPROVAL_REJECTION_TEXT,
  CONFIRM_DELETIONS_WARNING_TEXT,
  JSONL_UNAVAILABLE_TEXT,
  LOCATION_STATE_TEXT,
  NORMALIZER_UNAVAILABLE_TEXT,
  NOT_WATCHING_TEXT,
  PICK_BACKEND_UNAVAILABLE_TEXT,
  REVOKE_WARNING_TEXT,
} from "./local-locations-text.ts";

/** The part of the Electron preload's `window.pki` this section uses. */
export interface PickerBridge {
  pickLocation?(
    type: LocationKind,
  ): Promise<{ ticket: string | null; failed?: "backend-unavailable" }>;
}

/** The kinds of an approved location the screen adds (I02B-R3). */
export type LocationKind = LocalLocationInfo["type"];

/** The buttons that add a location, by kind. */
const ADD_BUTTON: readonly { type: LocationKind; text: string }[] = [
  { type: "folder", text: "폴더 추가" },
  { type: "file", text: "파일 추가" },
  { type: "jsonl-file", text: "JSONL 파일 추가" },
];

const noAction = () => undefined;

/** A refused or failed action as the text the user reads. */
export function actionFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const text = ACTION_REFUSAL_TEXT[error.code];
    if (text !== undefined) return text;
  }
  return `하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
}

export type AddResult = { added: true } | { added: false; text: string };

/** Asks the backend to approve; a refusal becomes its text, any other failure its message. */
export async function addLocation(
  api: ApiClient,
  request: { type: LocationKind; path: string } | { type: LocationKind; ticket: string },
): Promise<AddResult> {
  try {
    await api("approveLocalLocation", request);
    return { added: true };
  } catch (error) {
    if (error instanceof ApiError && error.code === "approval-rejected") {
      const text = APPROVAL_REJECTION_TEXT[error.detail as LocalApprovalRejectionCode];
      if (text !== undefined) return { added: false, text };
    }
    return {
      added: false,
      text: `추가하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The shell's picker, then the approval with its ticket; undefined when the user cancelled. */
export async function pickAndAdd(
  api: ApiClient,
  pick: NonNullable<PickerBridge["pickLocation"]>,
  type: LocationKind = "folder",
): Promise<AddResult | undefined> {
  const { ticket, failed } = await pick(type);
  if (failed !== undefined) return { added: false, text: PICK_BACKEND_UNAVAILABLE_TEXT };
  return ticket === null ? undefined : addLocation(api, { type, ticket });
}

/** The shell's picker of the location's own kind, then the relink with its ticket; the text to show when the pick could not be handed to the backend, nothing when the user cancelled. */
export async function pickAndRelink(
  api: ApiClient,
  pick: NonNullable<PickerBridge["pickLocation"]>,
  location: Pick<LocalLocationInfo, "id" | "type">,
): Promise<string | undefined> {
  const { ticket, failed } = await pick(location.type);
  if (failed !== undefined) return PICK_BACKEND_UNAVAILABLE_TEXT;
  if (ticket !== null) await api("relinkLocalLocation", { locationId: location.id, ticket });
  return undefined;
}

export function LocationList({
  list,
  onAction = noAction,
  skipped,
  onReimport = noAction,
}: {
  list: LocalLocationList;
  onAction?: (action: LocationAction, location: LocalLocationInfo) => void;
  /** The open skipped list, with the location it belongs to. */
  skipped?: { locationId: string; page: LocalSkippedResponse } | undefined;
  onReimport?: (locationId: string, relativePath: string) => void;
}) {
  return (
    <>
      {list.normalizerUnavailable && <p role="alert">{NORMALIZER_UNAVAILABLE_TEXT}</p>}
      {list.locations.length === 0 ? (
        <p>추가한 폴더가 없습니다.</p>
      ) : (
        <table aria-label="로컬 자료 위치">
          <thead>
            <tr>
              <th scope="col">경로</th>
              <th scope="col">상태</th>
              <th scope="col">읽은 파일 / 건너뜀 / 무시</th>
              <th scope="col">마지막 훑기</th>
              <th scope="col">동작</th>
            </tr>
          </thead>
          <tbody>
            {list.locations.map((l) => (
              <Fragment key={l.id}>
                <tr>
                  <td>
                    <bdi>{l.displayPath}</bdi>
                  </td>
                  <td>
                    {LOCATION_STATE_TEXT[l.state]}
                    {l.state === "revoking" && ` · 남은 원본 ${l.counts.sources}개`}
                    {" · "}
                    {l.watching ? "실시간 감시 중" : NOT_WATCHING_TEXT}
                    {l.type === "jsonl-file" && l.state === "unavailable" && (
                      <p>{JSONL_UNAVAILABLE_TEXT}</p>
                    )}
                  </td>
                  <td>
                    {l.counts.tracked} / {l.counts.skipped} / {l.counts.ignored}
                  </td>
                  <td>{l.lastPassAt ?? "아직 없음"}</td>
                  <td>
                    <LocationActions location={l} onAction={onAction} />
                  </td>
                </tr>
                {skipped?.locationId === l.id && (
                  <tr>
                    <td colSpan={5}>
                      <SkippedList
                        page={skipped.page}
                        onReimport={(path) => onReimport(l.id, path)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function LocalLocations({
  api,
  bridge = (globalThis as { pki?: PickerBridge }).pki,
}: {
  api: ApiClient;
  bridge?: PickerBridge | undefined;
}) {
  const [list, setList] = useState<LocalLocationList>();
  const [refusal, setRefusal] = useState<string>();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{
    kind: "revoke" | "confirm";
    location: LocalLocationInfo;
  }>();
  const [skipped, setSkipped] = useState<{ locationId: string; page: LocalSkippedResponse }>();

  const load = useCallback(() => {
    api("localLocations").then(setList, () => undefined);
  }, [api]);
  useEffect(load, [load]);

  async function run(add: () => Promise<AddResult | undefined>) {
    setBusy(true);
    setRefusal(undefined);
    try {
      const result = await add();
      if (result && !result.added) setRefusal(result.text);
      load();
    } finally {
      setBusy(false);
    }
  }

  /** One backend action; a refusal becomes its text, and the list is reloaded either way. */
  async function act(task: () => Promise<unknown>) {
    setBusy(true);
    setRefusal(undefined);
    try {
      await task();
    } catch (error) {
      setRefusal(actionFailure(error));
    } finally {
      setBusy(false);
      load();
    }
  }

  const pick = bridge?.pickLocation?.bind(bridge);

  async function openSkipped(locationId: string) {
    const page = await api("localSkipped", { locationId, offset: 0, limit: 100 });
    setSkipped({ locationId, page });
  }

  function onAction(action: LocationAction, location: LocalLocationInfo) {
    const locationId = location.id;
    switch (action) {
      case "pause":
        return void act(() => api("pauseLocalLocation", { locationId }));
      case "resume":
        return void act(() => api("resumeLocalLocation", { locationId }));
      case "rescan":
        return void act(() => api("rescanLocalLocation", { locationId }));
      case "relink":
        return void act(async () => {
          if (import.meta.env.DEV) {
            await api("relinkLocalLocation", { locationId, path });
          } else if (pick) {
            const text = await pickAndRelink(api, pick, location);
            if (text !== undefined) setRefusal(text);
          }
        });
      case "confirm":
      case "revoke":
        return setDialog({ kind: action, location });
      case "revokeContinue":
        return void act(() =>
          api("revokeLocalLocation", { locationId, count: location.counts.sources }),
        );
      case "skipped":
        return void act(async () => {
          if (skipped?.locationId === locationId) setSkipped(undefined);
          else await openSkipped(locationId);
        });
    }
  }

  function confirmDialog() {
    if (!dialog) return;
    const { kind, location } = dialog;
    setDialog(undefined);
    void act(() =>
      kind === "revoke"
        ? api("revokeLocalLocation", { locationId: location.id, count: location.counts.sources })
        : api("confirmLocalDeletions", {
            locationId: location.id,
            count: location.counts.pendingDeletes,
          }),
    );
  }

  const submitTyped = (event: FormEvent, type: LocationKind) => {
    event.preventDefault();
    void run(() => addLocation(api, { type, path }));
  };

  return (
    <section aria-labelledby="local-locations-heading">
      <h2 id="local-locations-heading">로컬 자료</h2>
      <div aria-live="polite">
        {list && (
          <LocationList
            list={list}
            onAction={onAction}
            skipped={skipped}
            onReimport={(locationId, relativePath) =>
              void act(async () => {
                await api("reimportLocalFile", { locationId, relativePath });
                await openSkipped(locationId);
              })
            }
          />
        )}
      </div>
      {dialog && (
        <ConfirmDialog
          title={dialog.kind === "revoke" ? "승인 철회" : "삭제 반영"}
          count={
            dialog.kind === "revoke"
              ? dialog.location.counts.sources
              : dialog.location.counts.pendingDeletes
          }
          countLabel={dialog.kind === "revoke" ? "지워질 원본" : "삭제를 반영할 파일"}
          warning={dialog.kind === "revoke" ? REVOKE_WARNING_TEXT : CONFIRM_DELETIONS_WARNING_TEXT}
          confirmLabel={dialog.kind === "revoke" ? "철회" : "반영"}
          onConfirm={confirmDialog}
          onCancel={() => setDialog(undefined)}
        />
      )}
      {import.meta.env.DEV ? (
        <form onSubmit={(event) => submitTyped(event, "folder")}>
          <label>
            경로(개발용)
            <input type="text" value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          {ADD_BUTTON.map(({ type, text }) => (
            <button
              key={type}
              type={type === "folder" ? "submit" : "button"}
              disabled={busy || path === ""}
              onClick={type === "folder" ? undefined : (e) => submitTyped(e, type)}
            >
              {text}
            </button>
          ))}
        </form>
      ) : (
        pick &&
        ADD_BUTTON.map(({ type, text }) => (
          <button
            key={type}
            type="button"
            disabled={busy}
            onClick={() => void run(() => pickAndAdd(api, pick, type))}
          >
            {text}
          </button>
        ))
      )}
      {refusal && <p role="alert">{refusal}</p>}
    </section>
  );
}
