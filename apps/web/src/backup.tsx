// Settings' "백업·복원" section (H01-R16): the backup folder, an encrypted backup made with a passphrase typed
// twice, the files in the folder, a look at one file, and the restore the next start applies. In the Electron
// shell the folder comes from the OS picker's one-time ticket; in browser development a labelled input takes a
// typed path (the branch tests `import.meta.env.DEV`, so a production build drops it, as in local-locations.tsx).
// Passphrases live in uncontrolled inputs only: read when a request is sent and cleared right after, never in
// React state or in an attribute.
import type { RouteResponse } from "@pki/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiClient } from "./api.ts";
import {
  BACKUP_FOLDER_REFUSAL_TEXT,
  BACKUP_REFUSAL_TEXT,
  BACKUP_WARNINGS,
  PREVIOUS_COPY_TEXT,
  RESTORE_REFUSAL_TEXT,
  failureNotice,
  restoreResultText,
} from "./backup-text.ts";
import type { PickerBridge } from "./local-locations.tsx";
import { PICK_BACKEND_UNAVAILABLE_TEXT } from "./local-locations-text.ts";

type Status = RouteResponse<"backupStatus">;
type Inspection = RouteResponse<"inspectRestore">;
type Counts = NonNullable<Inspection["summary"]>["counts"];

const COUNT_LABELS: readonly [keyof Counts, string][] = [
  ["sources", "원본"],
  ["items", "항목"],
  ["facts", "사실"],
  ["relations", "관계"],
  ["evidence", "근거"],
  ["openJobs", "열린 작업"],
  ["tombstones", "삭제 기록"],
];

/** The shell's folder picker, then `choose` with its ticket; the text to show when the pick could not be handed to the backend, nothing on a cancel (UIF-R2). */
export async function pickBackupFolder(
  pick: NonNullable<PickerBridge["pickLocation"]>,
  choose: (request: { ticket: string }) => Promise<unknown>,
): Promise<string | undefined> {
  const { ticket, failed } = await pick("folder");
  if (failed !== undefined) return PICK_BACKEND_UNAVAILABLE_TEXT;
  if (ticket !== null) await choose({ ticket });
  return undefined;
}

const SHOWN_RESULT_KEY = "pki.restore.shown";

export const countsText = (counts: Counts): string =>
  COUNT_LABELS.map(([key, label]) => `${label} ${counts[key]}`).join(" · ");

const failureText = (error: unknown) =>
  `하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;

export function BackupRestore({
  api,
  bridge = (globalThis as { pki?: PickerBridge }).pki,
}: {
  api: ApiClient;
  bridge?: PickerBridge | undefined;
}) {
  const [status, setStatus] = useState<Status>();
  const [refusal, setRefusal] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");
  const [passphrasesMatch, setPassphrasesMatch] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [inspection, setInspection] = useState<{ fileName: string; result: Inspection }>();
  const [resultShown, setResultShown] = useState<string | null>(
    () => globalThis.sessionStorage?.getItem(SHOWN_RESULT_KEY) ?? null,
  );
  const created = useRef<HTMLInputElement>(null);
  const confirmed = useRef<HTMLInputElement>(null);
  const restoring = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api("backupStatus").then(setStatus, () => undefined);
  }, [api]);
  useEffect(load, [load]);

  /** One request; its failure is shown in words and the list is read again either way. */
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setRefusal(undefined);
    try {
      await task();
    } catch (error) {
      setRefusal(failureText(error));
    } finally {
      setBusy(false);
      load();
    }
  }

  const chooseFolder = (request: { path: string } | { ticket: string }) =>
    run(async () => {
      const answer = await api("setBackupFolder", request);
      if (answer.status === "refused" && answer.code) {
        setRefusal(BACKUP_FOLDER_REFUSAL_TEXT[answer.code]);
      } else {
        setNotice(undefined);
      }
    });

  const pick = bridge?.pickLocation?.bind(bridge);

  const comparePassphrases = () =>
    setPassphrasesMatch(
      created.current?.value !== undefined &&
        created.current.value.length >= (status?.minPassphraseLength ?? 12) &&
        created.current.value === confirmed.current?.value,
    );

  function makeBackup(event: FormEvent) {
    event.preventDefault();
    const passphrase = created.current?.value ?? "";
    if (created.current) created.current.value = "";
    if (confirmed.current) confirmed.current.value = "";
    setPassphrasesMatch(false);
    void run(async () => {
      const answer = await api("createBackup", { passphrase });
      if (answer.status === "refused" && answer.code) setRefusal(BACKUP_REFUSAL_TEXT[answer.code]);
      else setNotice(`백업을 만들었습니다: ${answer.fileName ?? ""}`);
    });
  }

  function look(event: FormEvent) {
    event.preventDefault();
    if (selected === undefined) return;
    const passphrase = restoring.current?.value ?? "";
    void run(async () => {
      const result = await api("inspectRestore", { fileName: selected, passphrase });
      if (result.status === "refused" && result.code) {
        setInspection(undefined);
        setRefusal(RESTORE_REFUSAL_TEXT[result.code]);
      } else {
        setInspection({ fileName: selected, result });
      }
    });
  }

  function restore() {
    const summary = inspection?.result.summary;
    if (!inspection || !summary) return;
    const passphrase = restoring.current?.value ?? "";
    void run(async () => {
      const answer = await api("restoreBackup", {
        fileName: inspection.fileName,
        passphrase,
        confirmBackupId: summary.backupId,
      });
      if (answer.status === "refused" && answer.code) {
        setRefusal(RESTORE_REFUSAL_TEXT[answer.code]);
        return;
      }
      if (restoring.current) restoring.current.value = "";
      setInspection(undefined);
      setSelected(undefined);
    });
  }

  const cancelRestore = () =>
    run(async () => {
      const answer = await api("cancelRestore");
      if (answer.status === "refused") setRefusal(PREVIOUS_COPY_TEXT);
      else setNotice("복원을 취소했습니다.");
    });

  const stuck = status ? failureNotice(status.failure, status.previousCopy) : null;
  const last = status?.last;
  const showLast = last && last.appliedAt !== resultShown;
  const dismissLast = () => {
    if (!last) return;
    globalThis.sessionStorage?.setItem(SHOWN_RESULT_KEY, last.appliedAt);
    setResultShown(last.appliedAt);
  };

  return (
    <section aria-labelledby="backup-heading">
      <h2 id="backup-heading">백업·복원</h2>
      <ul aria-label="백업 전에 알아 둘 것">
        {BACKUP_WARNINGS.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>

      {showLast && (
        <p role="status">
          {restoreResultText(last)} <button onClick={dismissLast}>확인</button>
        </p>
      )}
      {stuck && (
        <p role="alert">
          {stuck.text}{" "}
          {stuck.closable && (
            <button disabled={busy} onClick={() => void cancelRestore()}>
              알림 닫기
            </button>
          )}
        </p>
      )}

      <p>
        백업 폴더: {status?.folder ? <bdi>{status.folder}</bdi> : "아직 정하지 않았습니다"}
        {status?.folder && !status.folderUsable && " (쓸 수 없는 폴더입니다)"}
      </p>
      {import.meta.env.DEV ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void chooseFolder({ path });
          }}
        >
          <label>
            백업을 둘 폴더(개발용)
            <input type="text" value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          <button type="submit" disabled={busy || path === ""}>
            폴더 정하기
          </button>
        </form>
      ) : (
        pick && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void (async () => {
                const text = await pickBackupFolder(pick, chooseFolder);
                if (text !== undefined) setRefusal(text);
              })()
            }
          >
            폴더 고르기
          </button>
        )
      )}

      <form onSubmit={makeBackup}>
        <label>
          암호구
          <input type="password" autoComplete="off" ref={created} onInput={comparePassphrases} />
        </label>
        <label>
          암호구 확인
          <input type="password" autoComplete="off" ref={confirmed} onInput={comparePassphrases} />
        </label>
        <button type="submit" disabled={busy || !status?.folderUsable || !passphrasesMatch}>
          백업 만들기
        </button>
      </form>

      {status && status.files.length > 0 ? (
        <table aria-label="백업 파일">
          <thead>
            <tr>
              <th scope="col">파일</th>
              <th scope="col">만든 때</th>
              <th scope="col">크기</th>
              <th scope="col">동작</th>
            </tr>
          </thead>
          <tbody>
            {status.files.map((f) => (
              <tr key={f.fileName}>
                <td>{f.fileName}</td>
                <td>{f.createdAt}</td>
                <td>{f.bytes}</td>
                <td>
                  <button
                    disabled={busy || status.pending !== null}
                    onClick={() => {
                      setSelected(f.fileName);
                      setInspection(undefined);
                    }}
                  >
                    살펴보기
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>백업 파일이 없습니다.</p>
      )}

      {selected !== undefined && !status?.pending && (
        <form onSubmit={look} aria-label="백업 살펴보기">
          <p>
            <bdi>{selected}</bdi>
          </p>
          <label>
            이 백업의 암호구
            <input type="password" autoComplete="off" ref={restoring} />
          </label>
          <button type="submit" disabled={busy}>
            열어 보기
          </button>
        </form>
      )}

      {inspection?.result.summary && !status?.pending && (
        <div aria-label="살펴본 결과">
          <p>
            만든 때 {inspection.result.summary.createdAt} ·{" "}
            {countsText(inspection.result.summary.counts)}
          </p>
          <p>
            스키마: {SCHEMA_TEXT[inspection.result.schema ?? "same"]} · 설치:{" "}
            {INSTALLATION_TEXT[inspection.result.installation ?? "unknown"]} · 임베딩 공간:{" "}
            {inspection.result.embeddingSpace === "different"
              ? "지금과 다름(복원 뒤 다시 만듭니다)"
              : "같음"}
          </p>
          <button disabled={busy} onClick={restore}>
            이 백업으로 복원
          </button>
        </div>
      )}

      {status?.pending && (
        <p role="status">
          복원이 준비됐습니다. 앱을 다시 시작하면 적용됩니다({status.pending.backupCreatedAt}의
          백업, {countsText(status.pending.counts)}). 그때까지 한 변경은 복원과 함께 사라집니다.{" "}
          <button disabled={busy} onClick={() => void cancelRestore()}>
            복원 취소
          </button>
        </p>
      )}

      {notice && <p role="status">{notice}</p>}
      {refusal && <p role="alert">{refusal}</p>}
    </section>
  );
}

const SCHEMA_TEXT = {
  same: "같음",
  older: "옛 버전(복원할 때 올립니다)",
  newer: "새 버전(복원할 수 없습니다)",
} as const;

const INSTALLATION_TEXT = {
  same: "이 설치의 백업",
  other: "다른 설치의 백업",
  unknown: "알 수 없음",
} as const;
