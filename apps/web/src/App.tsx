// The four minimal screens (V01-R3). Every value shown comes from the backend through
// the API client; the screens hold labels only, never data.
import type {
  ComponentStatus,
  ConnectorSummary,
  RouteResponse,
  SourceSummary,
} from "@pki/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiClient } from "./api.ts";

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

type ReadRoute = "status" | "connectors" | "sources" | "activity" | "settings";

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

const STATE_LABEL = {
  ready: "준비됨",
  rebuilding: "재구성 중",
  unavailable: "사용 불가",
  "not-implemented": "미구현",
} as const;

const statusText = (status: ComponentStatus) =>
  status.state === "unavailable"
    ? `${STATE_LABEL.unavailable}: ${status.reason}`
    : STATE_LABEL[status.state];

const COMPONENTS = {
  backend: "백엔드",
  provider: "Provider",
  embedding: "Embedding",
  vectorIndex: "벡터 색인",
} as const;

function Home({ api }: { api: ApiClient }) {
  const { data, error } = useRoute(api, "status");
  return (
    <>
      <Failure error={error} />
      {data && (
        <table>
          <tbody>
            {(Object.keys(COMPONENTS) as (keyof typeof COMPONENTS)[]).map((key) => (
              <tr key={key}>
                <th scope="row">{COMPONENTS[key]}</th>
                <td>{statusText(data[key])}</td>
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
              <th>목적지</th>
              <th>작업</th>
              <th>등급</th>
              <th>결과</th>
              <th>소요(ms)</th>
            </tr>
          </thead>
          <tbody>
            {data.calls.map((c) => (
              <tr key={`${c.requestId}/${c.attempt}`}>
                <td>{c.createdAt}</td>
                <td>{c.provider}</td>
                <td>{c.destination}</td>
                <td>{c.taskKind}</td>
                <td>{c.classification}</td>
                <td>{c.outcome}</td>
                <td>{c.durationMs ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

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
          </tbody>
        </table>
      )}
      <p>기본 Provider, 동의, 백그라운드 실행은 아직 설정할 수 없습니다.</p>
    </>
  );
}
