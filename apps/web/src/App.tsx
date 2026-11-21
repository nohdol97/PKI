// The four minimal screens (V01-R3). Every value shown comes from the backend through
// the API client; the screens hold labels only, never data.
import type {
  ConnectorSummary,
  ConsentList,
  DataClassification,
  ProviderCall,
  RouteResponse,
  SourceSummary,
} from "@pki/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiClient } from "./api.ts";
import { componentText, embeddingText } from "./status-text.ts";

const SCREENS = { home: "홈", sources: "원본", activity: "활동", settings: "설정" } as const;
type Screen = keyof typeof SCREENS;

export function App({ api }: { api: ApiClient }) {
  const [screen, setScreen] = useState<Screen>("home");
  const Current = { home: Home, sources: Sources, activity: Activity, settings: Settings }[screen];
  return (
    <>
      <nav>
        {(Object.keys(SCREENS) as Screen[]).map((id) => (
          <button
            key={id}
            type="button"
            aria-current={screen === id ? "page" : undefined}
            onClick={() => setScreen(id)}
          >
            {SCREENS[id]}
          </button>
        ))}
      </nav>
      <main>
        <h1>{SCREENS[screen]}</h1>
        <Current api={api} />
      </main>
    </>
  );
}

type ReadRoute = "status" | "connectors" | "sources" | "activity" | "settings" | "consents";

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
    ["Provider", componentText(status.provider)],
    ["Embedding", embeddingText(status.embedding)],
    ["벡터 색인", componentText(status.vectorIndex)],
  ] as const;
}

function Home({ api }: { api: ApiClient }) {
  const { data, error } = useRoute(api, "status");
  return (
    <>
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
    </>
  );
}

const CONNECTOR_STATE: Record<ConnectorSummary["state"], string> = {
  ready: "사용 가능",
  "not-implemented": "미구현(배포처 후속)",
  unavailable: "사용 불가",
};

function Sources({ api }: { api: ApiClient }) {
  const connectors = useRoute(api, "connectors");
  const stored = useRoute(api, "sources");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<SourceSummary[]>();
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(message(e));

  const sync = (connectorId: string) =>
    api("syncConnector", { connectorId }).then(() => {
      setFound(undefined);
      stored.reload();
    }, fail);
  const search = (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return setFound(undefined);
    api("searchSources", { query }).then((result) => setFound(result.sources), fail);
  };
  const shown = found ?? stored.data?.sources;

  return (
    <>
      <Failure error={connectors.error ?? stored.error ?? error} />
      <h2>Connector</h2>
      <table>
        <tbody>
          {connectors.data?.connectors.map((c) => (
            <tr key={c.id}>
              <th scope="row">{c.id}</th>
              <td>{c.kind}</td>
              <td>{CONNECTOR_STATE[c.state]}</td>
              <td>
                {c.state === "ready" && (
                  <button type="button" aria-label={`${c.id} 동기화`} onClick={() => sync(c.id)}>
                    동기화
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
      {shown?.length === 0 && <p>{found ? "찾은 원본이 없습니다." : "저장된 원본이 없습니다."}</p>}
      {shown && shown.length > 0 && (
        <table>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>{s.connectorId}</td>
                <td>{s.externalId}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
  const { data, error } = useRoute(api, "activity");
  return (
    <>
      <Failure error={error} />
      {data?.calls.length === 0 && <p>Provider 호출 기록이 없습니다.</p>}
      {data && data.calls.length > 0 && (
        <table>
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
                <td>{c.outcome}</td>
                <td>{c.reason ?? NONE}</td>
                <td>{c.durationMs ?? NONE}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const ENCRYPTION_LABEL = { "not-applied": "적용 안 됨", unknown: "확인할 수 없음" } as const;

function Settings({ api }: { api: ApiClient }) {
  const { data, error } = useRoute(api, "settings");
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
      <Consents api={api} />
      <p>기본 Provider와 백그라운드 실행은 아직 설정할 수 없습니다.</p>
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
  const grant = (entry: ConsentEntry) =>
    api("grantConsent", {
      providerId: entry.providerId,
      allowedClasses: chosen[entry.providerId] ?? [],
    }).then(
      () => {
        setChosen((prev) => ({ ...prev, [entry.providerId]: [] }));
        done();
      },
      (e: unknown) => setFailure(message(e)),
    );
  const revoke = (entry: ConsentEntry) =>
    api("revokeConsent", { providerId: entry.providerId }).then(done, (e: unknown) =>
      setFailure(message(e)),
    );

  return (
    <>
      <h2>외부 전송 동의</h2>
      <Failure error={error ?? failure} />
      <p>
        Provider에 보내는 요청은 이 PC 밖의 서버로 나갑니다. CLI Provider도 요청을 그 CLI의 벤더
        서비스로 보냅니다. 허용할 데이터 등급을 고르고 동의하기 전에는 아무것도 보내지 않습니다.
        목적지나 전송 정책이 바뀌면 동의는 무효가 되어 다시 받아야 합니다.
      </p>
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
                        onClick={() => grant(entry)}
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
