// The four minimal screens (V01-R3). Every value shown comes from the backend through
// the API client; the screens hold labels only, never data.
import type {
  ConnectionTestResult,
  ConsentList,
  DataClassification,
  ImportJsonlResponse,
  PrepareSource,
  ProviderCall,
  ProviderCheck,
  ProviderId,
  RouteResponse,
  SourceSummary,
} from "@pki/contracts";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { outcomeText } from "./activity-text.ts";
import { JobsArea } from "./activity-jobs.tsx";
import { ApiError, type ApiClient } from "./api.ts";
import {
  DEV_KEY_HINT,
  changeApiKey,
  keyStatusText,
  secretBridge,
  type SecretAction,
} from "./api-key.ts";
import { connectionTestText, needsUnverifiedConfirmation } from "./connection-test-text.ts";
import { BACKGROUND_EXECUTION_TEXT } from "./background-text.ts";
import { CONSENT_NOTICE } from "./consent-text.ts";
import { changeCredential, credentialOutcomeText, rereadDelaysMs } from "./connector-credential.ts";
import { ConnectorTable } from "./connector-table.tsx";
import { SecretField } from "./secret-field.tsx";
import { nextSyncStops } from "./connector-text.ts";
import { deleteConfirmText, deletedText, notDeletedText } from "./delete-text.ts";
import { INSIGHT_INTERPRET_TEXT } from "./evidence-text.ts";
import { Insights } from "./evidence-view.tsx";
import { Ask } from "./ask.tsx";
import { useChanges } from "./changes.ts";
import { Lint } from "./lint.tsx";
import { Notifications } from "./notifications.tsx";
import { unreadBadge } from "./notifications-text.ts";
import { Wiki } from "./wiki.tsx";
import { importSummaryText, lineErrorText } from "./import-text.ts";
import { Explore } from "./explore.tsx";
import { BackupRestore } from "./backup.tsx";
import { LocalLocations } from "./local-locations.tsx";
import { NavProvider } from "./nav.tsx";
import { SemanticReview } from "./semantic-review.tsx";
import { Ontology } from "./ontology.tsx";
import { MoreButton, usePaged } from "./paged-list.tsx";
import { invalidationText } from "./job-text.ts";
import { writeInsightInterpret } from "./insight-settings.ts";
import { connectionTestGuidance, providerCheckText, providerName } from "./provider-text.ts";
import {
  componentText,
  DOWNLOAD_APPROVAL,
  dataProtectionText,
  embeddingText,
  LOCAL_PACK_HINT,
  providerStatusText,
  vectorIndexText,
} from "./status-text.ts";

const SCREENS = {
  home: "홈",
  sources: "원본",
  notifications: "알림",
  wiki: "위키",
  lint: "점검",
  ask: "질문",
  explore: "탐색",
  semantic: "지식 검토",
  ontology: "유형 정의",
  activity: "활동",
  settings: "설정",
} as const;
type Screen = keyof typeof SCREENS;

export function App({ api }: { api: ApiClient }) {
  const [screen, setScreen] = useState<Screen>("home");
  // P02-R16: one poll of the change numbers; a screen that gets `key` reads its data again when it changes
  const changes = useChanges(api);
  const shown = {
    home: () => <Home api={api} refresh={changes.key} />,
    sources: () => <Sources api={api} />,
    notifications: () => <Notifications api={api} refresh={changes.key} />,
    wiki: () => <Wiki api={api} />,
    lint: () => <Lint api={api} />,
    ask: () => <Ask api={api} />,
    explore: () => <Explore api={api} />,
    semantic: () => <SemanticReview api={api} />,
    ontology: () => <Ontology api={api} />,
    activity: () => <Activity api={api} />,
    settings: () => <Settings api={api} />,
  }[screen];
  return (
    <NavProvider screen={screen} onScreen={setScreen}>
      <nav>
        {(Object.keys(SCREENS) as Screen[]).map((id) => (
          <button
            key={id}
            type="button"
            aria-current={screen === id ? "page" : undefined}
            onClick={() => setScreen(id)}
          >
            {SCREENS[id]}
            {id === "notifications" && unreadBadge(changes.unread)}
          </button>
        ))}
      </nav>
      <main>
        <h1>{SCREENS[screen]}</h1>
        {shown()}
      </main>
    </NavProvider>
  );
}

type ReadRoute =
  | "status"
  | "connectors"
  | "settings"
  | "consents"
  | "executionSettings"
  | "semanticSettings"
  | "providers";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Fetches a read route on mount; `reload` fetches it again. */
function useRoute<Name extends ReadRoute>(api: ApiClient, name: Name) {
  const [state, setState] = useState<{ data?: RouteResponse<Name>; error?: string }>({});
  const reload = useCallback(() => {
    (api as (route: Name) => Promise<RouteResponse<Name>>)(name).then(
      (data) => setState({ data }),
      (error: unknown) => setState({ error: message(error) }),
    );
  }, [api, name]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

function Failure({ error }: { error: string | undefined }) {
  return error ? <p role="alert">불러오지 못했습니다: {error}</p> : null;
}

function statusRows(status: RouteResponse<"status">) {
  return [
    ["백엔드", componentText(status.backend)],
    ["Provider", providerStatusText(status.provider).text],
    ["Embedding", embeddingText(status.embedding)],
    ["벡터 색인", vectorIndexText(status.vectorIndex)],
    ["데이터 보호", dataProtectionText(status.dataProtection)],
  ] as const;
}

function Home({ api, refresh }: { api: ApiClient; refresh: string }) {
  const { data, error, reload } = useRoute(api, "status");
  const preparing = data?.embedding.state === "preparing";
  // a preparation runs in the backend; Home reads the state again until it ends
  useEffect(() => {
    if (!preparing) return;
    const timer = setTimeout(reload, 1_000);
    return () => clearTimeout(timer);
  }, [preparing, data, reload]);
  const guidance = data && providerStatusText(data.provider).guidance;
  return (
    <>
      <Insights api={api} refresh={refresh} />
      <h2>상태</h2>
      <Failure error={error} />
      {data && (
        <table>
          <tbody>
            {statusRows(data).map(([label, text]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {guidance && <p>{guidance}</p>}
      {data && ["model-missing", "unavailable"].includes(data.embedding.state) && (
        <PrepareModel api={api} onStarted={reload} />
      )}
    </>
  );
}

/**
 * V01-R14, T14 handoff 5: the user's approval that starts a model preparation,
 * from a local pack folder or by the pinned download. Nothing else starts one;
 * the download asks first and names where the files come from.
 */
function PrepareModel({ api, onStarted }: { api: ApiClient; onStarted: () => void }) {
  const [path, setPath] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string>();
  const prepare = (source: PrepareSource) => {
    setConfirming(false);
    api("prepareEmbedding", { source }).then(
      () => {
        setFailure(undefined);
        onStarted();
      },
      (e: unknown) => setFailure(message(e)),
    );
  };
  const fromPack = (event: FormEvent) => {
    event.preventDefault();
    if (path.trim()) prepare({ kind: "local-pack", path: path.trim() });
  };
  return (
    <>
      <h2>Embedding 모델 준비</h2>
      <p>
        모델이 없어도 저장된 원본의 목록과 키워드 검색은 그대로 동작합니다. 모델은 아래에서 고른
        방법으로만 준비합니다.
      </p>
      <Failure error={failure} />
      <form onSubmit={fromPack}>
        <p>{LOCAL_PACK_HINT}</p>
        <input
          type="text"
          aria-label="로컬 팩 폴더"
          maxLength={4096}
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="submit">로컬 팩에서 준비</button>
      </form>
      {confirming ? (
        <div role="alertdialog" aria-labelledby="download-title" aria-describedby="download-body">
          <h3 id="download-title">모델 내려받기</h3>
          <p id="download-body">{DOWNLOAD_APPROVAL}</p>
          <button type="button" onClick={() => prepare({ kind: "download" })}>
            내려받기 승인
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            취소
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>
          모델 내려받기…
        </button>
      )}
    </>
  );
}

function Sources({ api }: { api: ApiClient }) {
  const connectors = useRoute(api, "connectors");
  const readStored = useCallback(
    async (before?: number) => {
      const page = await api("sourcesPage", before === undefined ? {} : { before });
      return { rows: page.sources, next: page.next };
    },
    [api],
  );
  const stored = usePaged(readStored);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<SourceSummary[]>();
  const [imported, setImported] = useState<ImportJsonlResponse>();
  const [confirming, setConfirming] = useState<SourceSummary>();
  const [deleted, setDeleted] = useState<string>();
  const [error, setError] = useState<string>();
  const [syncStops, setSyncStops] = useState<Record<string, string>>({});
  const [credentialNotes, setCredentialNotes] = useState<Record<string, string>>({});
  const rereads = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = rereads.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  const bridge = secretBridge();
  const fail = (e: unknown) => setError(message(e));

  // I06-R14: the value goes to the shell's store, the backend is told which instance changed
  const changeConnectorCredential = async (
    connectorId: string,
    name: string,
    action: SecretAction,
  ) => {
    if (!bridge) return;
    const outcome = await changeCredential({ bridge, api }, connectorId, name, action);
    setCredentialNotes((notes) => ({ ...notes, [connectorId]: credentialOutcomeText(outcome) }));
    for (const delay of rereadDelaysMs(outcome)) {
      if (delay === 0) connectors.reload();
      else {
        const timer = setTimeout(() => {
          rereads.current.delete(timer);
          connectors.reload();
        }, delay);
        rereads.current.add(timer);
      }
    }
  };

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // the same file can be chosen again (re-import)
    if (!file) return;
    file
      .text()
      .then((text) => api("importJsonl", { text }))
      .then((result) => {
        setImported(result);
        setDeleted(undefined);
        setFound(undefined);
        stored.reload();
      }, fail);
  };
  const sync = (connectorId: string) =>
    api("syncConnector", { connectorId }).then(
      (result) => {
        setSyncStops((stops) => nextSyncStops(stops, connectorId, result.stopped));
        setFound(undefined);
        stored.reload();
      },
      (e: unknown) => {
        setSyncStops((stops) => nextSyncStops(stops, connectorId, undefined));
        fail(e);
      },
    );
  const search = (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return setFound(undefined);
    api("searchSources", { query }).then((result) => setFound(result.sources), fail);
  };
  const remove = (source: SourceSummary) => {
    setConfirming(undefined);
    const { connectorId, namespace, externalId } = source;
    api("deleteSource", { connectorId, namespace, externalId }).then(
      (result) => {
        setDeleted(deletedText(source.title, result.outcome));
        setFound(undefined);
        stored.reload();
      },
      (e: unknown) =>
        e instanceof ApiError && e.code === "ledger-unwritable"
          ? setDeleted(notDeletedText(source.title))
          : fail(e),
    );
  };
  const shown = found ?? stored.shown?.rows;

  return (
    <>
      <Failure error={connectors.error ?? stored.error ?? error} />
      <h2>Connector</h2>
      <ConnectorTable
        connectors={connectors.data?.connectors ?? []}
        syncStops={syncStops}
        onSync={sync}
        canEnterCredentials={bridge !== undefined}
        credentialNotes={credentialNotes}
        onCredentialChange={changeConnectorCredential}
      />
      <h2>JSONL 가져오기</h2>
      <input
        type="file"
        aria-label="JSONL 파일 가져오기"
        accept=".jsonl,application/jsonl,application/x-ndjson"
        onChange={importFile}
      />
      {imported && (
        <>
          <p role="status">{importSummaryText(imported)}</p>
          {imported.errors.length > 0 && (
            <ul aria-label="거부된 줄">
              {imported.errors.map((e) => (
                <li key={e.line}>{lineErrorText(e)}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <h2>저장된 원본</h2>
      <form role="search" onSubmit={search}>
        <input
          type="search"
          aria-label="검색어"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit">검색</button>
      </form>
      {deleted && <p role="status">{deleted}</p>}
      {confirming && (
        <div role="alertdialog" aria-label="원본 삭제 확인">
          <p>{deleteConfirmText(confirming.title)}</p>
          <button type="button" onClick={() => remove(confirming)}>
            지우기
          </button>
          <button type="button" onClick={() => setConfirming(undefined)}>
            취소
          </button>
        </div>
      )}
      {stored.loading && !stored.shown && !found && (
        <p role="status">저장된 원본을 불러오는 중입니다.</p>
      )}
      {shown?.length === 0 && <p>{found ? "찾은 원본이 없습니다." : "저장된 원본이 없습니다."}</p>}
      {shown && shown.length > 0 && (
        <table>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>{s.connectorId}</td>
                <td>{s.namespace ? `${s.namespace} / ${s.externalId}` : s.externalId}</td>
                <td>
                  <button
                    type="button"
                    aria-label={`${s.title} 삭제`}
                    onClick={() => {
                      // one result at a time: the earlier import's or deletion's goes
                      setImported(undefined);
                      setDeleted(undefined);
                      setConfirming(s);
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!found && (
        <MoreButton
          next={stored.shown?.next ?? null}
          loading={stored.loading}
          onMore={stored.more}
          label="원본"
        />
      )}
    </>
  );
}

/** A CLI runs on this PC but sends the request to its vendor: external egress (ADR 0014). */
const EGRESS_LABEL: Record<ProviderCall["egress"], string> = {
  external: "외부 전송",
  local: "이 PC 안",
};

const CLASS_LABEL: Record<DataClassification, string> = { synthetic: "합성", general: "일반" };

const NONE = "—";

function Activity({ api }: { api: ApiClient }) {
  const readCalls = useCallback(
    async (before?: number) => {
      const page = await api("activityPage", before === undefined ? {} : { before });
      return { rows: page.calls, next: page.next };
    },
    [api],
  );
  const calls = usePaged(readCalls);
  const { error } = calls;
  const data = calls.shown && { calls: calls.shown.rows };
  const status = useRoute(api, "status");
  return (
    <>
      <JobsArea api={api} onRefresh={status.reload} />
      <h2>무효화 기록</h2>
      <Failure error={status.error} />
      {status.data && <p>{invalidationText(status.data.invalidations)}</p>}
      <h2>Provider 호출 기록</h2>
      <Failure error={error} />
      {data?.calls.length === 0 && <p>Provider 호출 기록이 없습니다.</p>}
      {data && data.calls.length > 0 && (
        <table aria-label="Provider 호출 기록">
          <thead>
            <tr>
              <th>시각</th>
              <th>Provider</th>
              <th>전송</th>
              <th>목적지</th>
              <th>작업</th>
              <th>등급</th>
              <th>정책 버전</th>
              <th>결과</th>
              <th>사유</th>
              <th>소요(ms)</th>
            </tr>
          </thead>
          <tbody>
            {data.calls.map((c) => (
              <tr key={`${c.requestId}/${c.attempt}`}>
                <td>{c.createdAt}</td>
                <td>{c.provider}</td>
                <td>{EGRESS_LABEL[c.egress]}</td>
                <td>{c.destination ?? NONE}</td>
                <td>{c.taskKind}</td>
                <td>{c.classification}</td>
                <td>{c.policyVersion ?? NONE}</td>
                <td>{outcomeText(c.outcome)}</td>
                <td>{c.reason ?? NONE}</td>
                <td>{c.durationMs ?? NONE}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <MoreButton
        next={calls.shown?.next ?? null}
        loading={calls.loading}
        onMore={calls.more}
        label="Provider 호출 기록"
      />
    </>
  );
}

const ENCRYPTION_LABEL = { "not-applied": "적용 안 됨", unknown: "확인할 수 없음" } as const;

function Settings({ api }: { api: ApiClient }) {
  const { data, error, reload } = useRoute(api, "settings");
  return (
    <>
      <Failure error={error} />
      {data && (
        <table>
          <tbody>
            <tr>
              <th scope="row">데이터 폴더</th>
              <td>{data.dataDirectory}</td>
            </tr>
            <tr>
              <th scope="row">스키마 버전</th>
              <td>{data.schemaVersion}</td>
            </tr>
            <tr>
              <th scope="row">데이터베이스 암호화</th>
              <td>{ENCRYPTION_LABEL[data.databaseEncryption]}</td>
            </tr>
          </tbody>
        </table>
      )}
      {data && <OpenAICompatible api={api} settings={data} reload={reload} />}
      <Providers api={api} />
      <Consents api={api} />
      <ConnectionTest api={api} />
      <BackgroundExecution api={api} />
      <InsightInterpretSetting api={api} />
      <LocalLocations api={api} />
      <BackupRestore api={api} />
    </>
  );
}

/**
 * V01-R9, R5: the bound Providers, the user's default (the only one any call goes
 * to; none until picked), and "Provider 확인", which runs each one's version and
 * login status queries and shows install or login guidance for what is missing.
 */
function Providers({ api }: { api: ApiClient }) {
  const { data, error, reload } = useRoute(api, "providers");
  const [checks, setChecks] = useState<ProviderCheck[]>();
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<string>();
  const choose = (providerId: ProviderId) =>
    api("setDefaultProvider", { providerId }).then(
      () => {
        setFailure(undefined);
        reload();
      },
      (e: unknown) => setFailure(message(e)),
    );
  const check = () => {
    setChecking(true);
    api("checkProviders").then(
      (r) => {
        setChecking(false);
        setFailure(undefined);
        setChecks(r.providers);
      },
      (e: unknown) => {
        setChecking(false);
        setFailure(message(e));
      },
    );
  };
  return (
    <>
      <h2>Provider</h2>
      <Failure error={error ?? failure} />
      <p>
        연결 시험과 모든 호출은 고른 기본 Provider 하나로만 갑니다. 고르기 전에는 어느 Provider도
        부르지 않으며, 막힌 Provider 대신 다른 것을 쓰지 않습니다.
      </p>
      {data && (
        <fieldset>
          <legend>기본 Provider</legend>
          {data.providers.map((p) => {
            const found = checks?.find((c) => c.providerId === p.providerId);
            const text = found && providerCheckText(found);
            return (
              <div key={p.providerId}>
                <label>
                  <input
                    type="radio"
                    name="default-provider"
                    checked={data.defaultProvider === p.providerId}
                    onChange={() => choose(p.providerId)}
                  />
                  {providerName(p.providerId)}
                </label>
                {text && (
                  <p>
                    {providerName(p.providerId)}: {text.state}
                  </p>
                )}
                {text?.guidance && <p>{text.guidance}</p>}
              </div>
            );
          })}
        </fieldset>
      )}
      <button type="button" disabled={checking} onClick={check}>
        Provider 확인
      </button>
    </>
  );
}

/**
 * V01-R21: one structured call with the build's fixed synthetic material, through
 * the Broker's decisions like any other call. When the development build needs the
 * user's confirmation of the unverified-isolation warning, this screen asks for it
 * for that one call and sends it with the next request; nothing is stored.
 */
function ConnectionTest({ api }: { api: ApiClient }) {
  const [result, setResult] = useState<ConnectionTestResult>();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string>();
  const run = (acknowledgeUnverified: boolean) => {
    setConfirming(false);
    setRunning(true);
    setFailure(undefined);
    api("connectionTest", { acknowledgeUnverified }).then(
      (r) => {
        setRunning(false);
        setResult(r);
        setConfirming(!acknowledgeUnverified && needsUnverifiedConfirmation(r));
      },
      (e: unknown) => {
        setRunning(false);
        setFailure(message(e));
      },
    );
  };
  return (
    <>
      <h2>연결 시험</h2>
      <p>
        고정된 합성 시험 자료 하나로 Provider에 구조화 응답을 한 번 요청합니다. 다른 호출과 똑같이
        동의, 전송 규칙, CLI 실행 조건을 지나며 막히면 그 이유를 보입니다.
      </p>
      <button type="button" disabled={running || confirming} onClick={() => run(false)}>
        연결 시험
      </button>
      <Failure error={failure} />
      {confirming ? (
        <div
          role="alertdialog"
          aria-labelledby="unverified-title"
          aria-describedby="unverified-body"
        >
          <h3 id="unverified-title">격리 미검증</h3>
          <p id="unverified-body">
            이 CLI의 버전·OS·인자 프로필 조합은 격리(파일·도구 접근 차단)가 검증되지 않았습니다.
            개발 빌드에서만, 합성 시험 자료를 최소 권한 인자로 이번 한 번만 보냅니다. 확인은
            저장되지 않으며 다음 시험에서 다시 묻습니다.
          </p>
          <button type="button" onClick={() => run(true)}>
            이번 한 번 실행
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            취소
          </button>
        </div>
      ) : (
        result && (
          <>
            <p role="status">결과: {connectionTestText(result)}</p>
            {connectionTestGuidance(result) && <p>{connectionTestGuidance(result)}</p>}
          </>
        )
      )}
    </>
  );
}

/** V01-C7: background runs of a verified CLI combination stay off until the user turns them on. */
export function BackgroundExecution({ api }: { api: ApiClient }) {
  const { data, error, reload } = useRoute(api, "executionSettings");
  const [failure, setFailure] = useState<string>();
  const set = (cliBackground: boolean) =>
    api("setExecutionSettings", { cliBackground }).then(
      () => {
        setFailure(undefined);
        reload();
      },
      (e: unknown) => setFailure(message(e)),
    );
  return (
    <>
      <h2>백그라운드 실행</h2>
      <Failure error={error ?? failure} />
      <p>{BACKGROUND_EXECUTION_TEXT}</p>
      {data && (
        <label>
          <input
            type="checkbox"
            checked={data.cliBackground}
            onChange={(e) => set(e.target.checked)}
          />
          CLI 백그라운드 실행 허용
        </label>
      )}
    </>
  );
}

/** P01-R17: the LLM interpretation of Insights, off until the user turns it on. */
export function InsightInterpretSetting({ api }: { api: ApiClient }) {
  const { data, error, reload } = useRoute(api, "semanticSettings");
  const [failure, setFailure] = useState<string>();
  const set = (insightInterpret: boolean) =>
    writeInsightInterpret(api, insightInterpret).then(
      () => {
        setFailure(undefined);
        reload();
      },
      (e: unknown) => setFailure(message(e)),
    );
  return (
    <>
      <h2>Insight 해석</h2>
      <Failure error={error ?? failure} />
      <p>{INSIGHT_INTERPRET_TEXT}</p>
      {data && (
        <label>
          <input
            type="checkbox"
            checked={data.insightInterpret}
            onChange={(e) => set(e.target.checked)}
          />
          Insight LLM 해석 사용
        </label>
      )}
    </>
  );
}

/**
 * The OpenAI-compatible endpoint, model and API key (V01-R11, site-setup S05). The key
 * is stored per endpoint host and shown by presence only; changing the host asks for
 * the key again (review A-F3/B-B1).
 */
function OpenAICompatible({
  api,
  settings,
  reload,
}: {
  api: ApiClient;
  settings: RouteResponse<"settings">;
  reload: () => void;
}) {
  const current = settings.openaiCompatible;
  const [baseUrl, setBaseUrl] = useState(current.baseUrl ?? "");
  const [model, setModel] = useState(current.model ?? "");
  const [failure, setFailure] = useState<string>();
  const bridge = secretBridge();
  const saveEndpoint = (event: FormEvent) => {
    event.preventDefault();
    api("writeSettings", { openaiCompatible: { baseUrl, model } }).then(
      () => (setFailure(undefined), reload()),
      (e: unknown) => setFailure(message(e)),
    );
  };
  // the field has cleared the value before this runs; what is left to say is what became of it
  const changeKey = async (action: SecretAction) => {
    if (!bridge || current.keyName === null) return;
    setFailure(await changeApiKey(bridge, current.keyName, action));
    if (action.kind !== "refused") reload();
  };
  return (
    <>
      <h2>OpenAI 호환 Provider</h2>
      <Failure error={failure} />
      <form onSubmit={saveEndpoint}>
        <label>
          주소
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label>
          모델
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <button type="submit" disabled={baseUrl === "" || model === ""}>
          주소 저장
        </button>
      </form>
      <table>
        <tbody>
          <tr>
            <th scope="row">API 키</th>
            <td>{keyStatusText(current)}</td>
          </tr>
        </tbody>
      </table>
      {bridge ? (
        <SecretField
          key={current.keyName}
          inputLabel={current.host === null ? "API 키" : `${current.host}에 쓸 API 키`}
          showLabel
          saveText="키 저장"
          {...(current.key === "present" && { remove: { text: "키 삭제" } })}
          disabled={current.keyName === null}
          onAction={changeKey}
        />
      ) : (
        <p>{DEV_KEY_HINT}</p>
      )}
    </>
  );
}

type ConsentEntry = ConsentList["providers"][number];

const DESTINATION_PROBLEM = {
  "destination-unavailable": "미설정",
  "insecure-endpoint": "https가 아닌 주소(차단)",
} as const;

function consentText(entry: ConsentEntry): string {
  const { consent } = entry;
  if (!consent) return "동의 없음";
  if (consent.state === "stale-destination") return "무효(목적지가 바뀜)";
  if (consent.state === "stale-policy") return "무효(전송 정책이 바뀜)";
  return `동의함: ${consent.allowedClasses.map((c) => CLASS_LABEL[c]).join(", ")}`;
}

/**
 * Consent per Provider (ADR 0014): where each Provider's requests go, which data
 * classes the user allows there, nothing chosen by default. A consent holds only
 * for the destination and policy version it was given for.
 */
function Consents({ api }: { api: ApiClient }) {
  const { data, error, reload } = useRoute(api, "consents");
  const [chosen, setChosen] = useState<Record<string, DataClassification[]>>({});
  const [failure, setFailure] = useState<string>();
  const done = () => {
    setFailure(undefined);
    reload();
  };
  const toggle = (id: string, c: DataClassification, on: boolean) =>
    setChosen((prev) => {
      const rest = (prev[id] ?? []).filter((x) => x !== c);
      return { ...prev, [id]: on ? [...rest, c] : rest };
    });
  // repeats what this screen shows; the backend refuses it if either changed meanwhile
  const grant = (entry: ConsentEntry, policyVersion: string) =>
    api("grantConsent", {
      providerId: entry.providerId,
      allowedClasses: chosen[entry.providerId] ?? [],
      destination: entry.destination ?? "",
      policyVersion,
    }).then(
      () => {
        setChosen((prev) => ({ ...prev, [entry.providerId]: [] }));
        done();
      },
      (e: unknown) => {
        setFailure(message(e));
        reload(); // show the destination and version as they are now
      },
    );
  const revoke = (entry: ConsentEntry) =>
    api("revokeConsent", { providerId: entry.providerId }).then(done, (e: unknown) =>
      setFailure(message(e)),
    );

  return (
    <>
      <h2>외부 전송 동의</h2>
      <Failure error={error ?? failure} />
      <p>{CONSENT_NOTICE}</p>
      {data && (
        <>
          <p>전송 정책 버전: {data.policyVersion}</p>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>전송</th>
                <th>목적지</th>
                <th>동의</th>
                <th>허용할 등급</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.providers.map((entry) => {
                const picked = chosen[entry.providerId] ?? [];
                return (
                  <tr key={entry.providerId}>
                    <th scope="row">{entry.providerId}</th>
                    <td>{EGRESS_LABEL[entry.egress]}</td>
                    <td>
                      {entry.destination ??
                        (entry.destinationProblem
                          ? DESTINATION_PROBLEM[entry.destinationProblem]
                          : NONE)}
                    </td>
                    <td>{consentText(entry)}</td>
                    <td>
                      {data.classes.map((c) => (
                        <label key={c}>
                          <input
                            type="checkbox"
                            aria-label={`${entry.providerId} ${CLASS_LABEL[c]} 허용`}
                            checked={picked.includes(c)}
                            disabled={entry.destination === null}
                            onChange={(e) => toggle(entry.providerId, c, e.target.checked)}
                          />
                          {CLASS_LABEL[c]}
                        </label>
                      ))}
                    </td>
                    <td>
                      <button
                        type="button"
                        aria-label={`${entry.providerId} 동의`}
                        disabled={entry.destination === null || picked.length === 0}
                        onClick={() => grant(entry, data.policyVersion)}
                      >
                        동의
                      </button>
                      {entry.consent && (
                        <button
                          type="button"
                          aria-label={`${entry.providerId} 동의 철회`}
                          onClick={() => revoke(entry)}
                        >
                          철회
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
