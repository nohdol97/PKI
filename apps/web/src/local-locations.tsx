// Settings' "로컬 자료" section (I02B-R36, R37, R38): the approved locations and one way to add a folder.
// In the Electron shell the button opens the OS folder picker through the preload and approves with the
// one-time ticket it returns; the page never holds the path. In browser development (Vite dev server) a
// labelled input takes a typed absolute path instead; the branch tests the compile-time `import.meta.env.DEV`,
// so the production build drops it and its label (bundle check: apps/desktop/e2e/build-web.setup.ts).
import type { LocalApprovalRejectionCode, LocalLocationList } from "@pki/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type ApiClient } from "./api.ts";
import {
  APPROVAL_REJECTION_TEXT,
  LOCATION_STATE_TEXT,
  NORMALIZER_UNAVAILABLE_TEXT,
  NOT_WATCHING_TEXT,
} from "./local-locations-text.ts";

/** The part of the Electron preload's `window.pki` this section uses. */
export interface PickerBridge {
  pickLocation?(type: "folder"): Promise<{ ticket: string | null }>;
}

export type AddResult = { added: true } | { added: false; text: string };

/** Asks the backend to approve; a refusal becomes its text, any other failure its message. */
export async function addFolder(
  api: ApiClient,
  request: { type: "folder"; path: string } | { type: "folder"; ticket: string },
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
): Promise<AddResult | undefined> {
  const { ticket } = await pick("folder");
  return ticket === null ? undefined : addFolder(api, { type: "folder", ticket });
}

export function LocationList({ list }: { list: LocalLocationList }) {
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
            </tr>
          </thead>
          <tbody>
            {list.locations.map((l) => (
              <tr key={l.id}>
                <td>
                  <bdi>{l.displayPath}</bdi>
                </td>
                <td>
                  {LOCATION_STATE_TEXT[l.state]} · {NOT_WATCHING_TEXT}
                </td>
                <td>
                  {l.counts.tracked} / {l.counts.skipped} / {l.counts.ignored}
                </td>
                <td>{l.lastPassAt ?? "아직 없음"}</td>
              </tr>
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

  const pick = bridge?.pickLocation?.bind(bridge);
  const submitTyped = (event: FormEvent) => {
    event.preventDefault();
    void run(() => addFolder(api, { type: "folder", path }));
  };

  return (
    <section aria-labelledby="local-locations-heading">
      <h2 id="local-locations-heading">로컬 자료</h2>
      <div aria-live="polite">{list && <LocationList list={list} />}</div>
      {import.meta.env.DEV ? (
        <form onSubmit={submitTyped}>
          <label>
            폴더 경로(개발용)
            <input type="text" value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || path === ""}>
            폴더 추가
          </button>
        </form>
      ) : (
        pick && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => pickAndAdd(api, pick))}
          >
            폴더 추가
          </button>
        )
      )}
      {refusal && <p role="alert">{refusal}</p>}
    </section>
  );
}
