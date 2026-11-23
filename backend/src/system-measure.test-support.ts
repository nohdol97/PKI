// H03-C2's measurement runner (docs/specs/2026-11-24-H03-C2-measure-runner.md): starts the real backend as a child
// process (system-measure.child.test-support.ts) with the stub Provider, feeds it synthetic documents through the
// product's import API, measures what EVALUATION 2.4 / 4.4 name that needs no installer, and returns one result
// object (version 1). Test-support, not product: it builds a Provider double, which only test code may.
// A value measured on a development machine is a reference, never a verdict (D2): thresholds are printed
// beside the values and nothing here says pass or fail.
import { routes, type JobsResponse } from "@pki/contracts";
import type { StructuredRequest } from "@pki/contracts";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { arch, cpus, release, tmpdir, totalmem, type as osType } from "node:os";
import { join, resolve } from "node:path";

export const SCHEMA_VERSION = 1;
export const STUB_PROVIDER_ID = "local-model";
/** The line every stub answer quotes; every synthetic document holds it (D6). */
export const STUB_QUOTE = "미리내 프로젝트의 완료 목표는 2026-12-05입니다";
export const STUB_ITEM_NAME = "미리내 프로젝트";

const ROOT = resolve(import.meta.dirname, "../..");
const CHILD = join(import.meta.dirname, "system-measure.child.test-support.ts");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const CHILD_CONFIG = join(ROOT, "vitest.system-measure.config.ts");
const INSTANCE = "conn-measure";
const SOURCE_TIMEOUT_MS = 60_000;
/** The product's job lease (2 minutes) plus room for the jobs behind the interrupted one. */
const KILL_WAIT_MS = 5 * 60_000;
const KILL_DOCS = 10;
const KILL_DELAY_MS = 1_000;
const DEFAULT_DELAY_MS = 50;

export type RunMode = "source-run" | "test-build";

// ---------------------------------------------------------------- thresholds (EVALUATION 4.4, verbatim)

/** One row of docs/EVALUATION.md section 4.4: its label and its threshold text, as written there. */
export interface ThresholdRow {
  label: string;
  text: string;
}
export const SYSTEM_THRESHOLDS = {
  installerSize: { label: "설치 파일 크기", text: "≤ 600 MB (모델 별도면 합계 ≤ 1.2 GB)" },
  idleCpu: { label: "유휴 CPU", text: "≤ 2 %" },
  idleMemory: { label: "유휴 메모리", text: "≤ 1.5 GB" },
  processingSearchable: {
    label: "신규 문서 처리(검색 가능까지, LLM 제외)",
    text: "p95 ≤ 3 s (10 KB 문서)",
  },
  processingExtracted: {
    label: "신규 문서 처리(지식 추출까지, LLM 포함)",
    text: "p95 ≤ 90 s (대기열 제외)",
  },
  search: { label: "검색 응답(LLM 답변 제외)", text: "p50 ≤ 300 ms, p95 ≤ 1.0 s (코퍼스 T2)" },
  llmCalls: { label: "LLM 호출", text: "신규 문서당 평균 ≤ 3, 최대 ≤ 8, Q&A 1건당 ≤ 1" },
  storage: { label: "파생 저장 공간", text: "≤ 원문 텍스트의 3배" },
  killRecover: {
    label: "강제 종료 후 복구",
    text: "재시작 후 ≤ 60 s에 작업 재개, 유실 0건, 중복 지식 항목 0건 (하드)",
  },
  soak: { label: "72시간 연속 가동", text: "충돌 0회, RSS 증가 ≤ 20 %" },
} as const satisfies Record<string, ThresholdRow>;
export type ThresholdKey = keyof typeof SYSTEM_THRESHOLDS;

const thresholdOf = (key: ThresholdKey) => ({ ...SYSTEM_THRESHOLDS[key] });

// ---------------------------------------------------------------- result type

export interface NotMeasured {
  status: "not-measured";
  reason: string;
}
export interface Latency {
  samples: number;
  p50Ms: number;
  p95Ms: number;
}
type WithThreshold = { threshold: ThresholdRow };
export type Metric<T> = (({ status: "measured" } & T) | NotMeasured) & WithThreshold;

export interface KillRecoverValue {
  /** The job lease the backend ran with (ms), and what built it. */
  leaseMs: number;
  leaseSource: "product default" | "test build override";
  docs: number;
  /** Running jobs seen just before the kill. */
  runningAtKill: number;
  /** Restart to the first job to run (D5), restart to every job finished. */
  firstJobAfterRestartMs: number;
  allJobsDoneMs: number;
  lostDocs: number;
  duplicateItems: number;
  note: string;
}

export interface MeasurementResult {
  schemaVersion: 1;
  ranAt: string;
  productCommit: string;
  workingTreeClean: boolean;
  mode: RunMode;
  environment: {
    cpu: string;
    logicalCores: number;
    ramGiB: number;
    os: string;
    node: string;
    grade: string;
  };
  args: {
    sources: number;
    docBytes: number;
    queries: number;
    warmupQueries: number;
    idleSeconds: number;
    soakSeconds: number;
    skipKill: boolean;
    stubDelayMs: number;
    jobLeaseMs: number;
    seed: number;
  };
  provider: { kind: "stub"; meaning: string };
  judgement: string;
  metrics: {
    installerSize: NotMeasured & WithThreshold;
    idleCpu: Metric<{ percentOfAllCores: number; observedSeconds: number; note: string }>;
    idleRss: Metric<{
      minMiB: number;
      medianMiB: number;
      maxMiB: number;
      observedSeconds: number;
      note: string;
    }>;
    processingSearchable: Metric<Latency & { definition: string }>;
    processingExtracted: Metric<Latency & { definition: string }>;
    search: Metric<Latency & { warmupDiscarded: number; definition: string }>;
    llmCalls: Metric<{
      total: number;
      byTaskKind: Record<string, number>;
      perDocAvg: number;
      answeredBy: "stub";
      maxPerDoc: NotMeasured;
      perQaQuestion: NotMeasured;
      daily: NotMeasured;
    }>;
    storage: Metric<{
      points: { sources: number; dataDirBytes: number; rawBytes: number }[];
      /** The data folder with the backend started and no document yet: the fixed cost a small corpus does not amortise. */
      emptyDataDirBytes: number;
      growthRatio: number;
      definition: string;
    }>;
    killRecover: Metric<KillRecoverValue>;
    soak: Metric<{
      seconds: number;
      documentsAdded: number;
      searches: number;
      crashes: number;
      rssStartMiB: number;
      rssEndMiB: number;
    }>;
  };
  unverified: { item: string; reason: string }[];
}

const notMeasured = (key: ThresholdKey, reason: string) =>
  ({ status: "not-measured", reason, threshold: thresholdOf(key) }) as const;

// ---------------------------------------------------------------- validator

/** What is wrong with a result, one line each; an empty list means it passes the same checks everywhere. */
export function validateResult(value: unknown): string[] {
  const problems: string[] = [];
  const at = (path: string, ok: boolean, what: string) => {
    if (!ok) problems.push(`${path}: ${what}`);
  };
  const get = (obj: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
  const positive = (path: string) => {
    const v = get(value, path);
    at(
      path,
      typeof v === "number" && Number.isFinite(v) && v > 0,
      `not a finite positive number (${String(v)})`,
    );
  };
  const nonNegative = (path: string) => {
    const v = get(value, path);
    at(
      path,
      typeof v === "number" && Number.isFinite(v) && v >= 0,
      `not a finite number >= 0 (${String(v)})`,
    );
  };
  at("schemaVersion", get(value, "schemaVersion") === SCHEMA_VERSION, "must be 1");
  for (const k of ["ranAt", "productCommit", "mode"]) {
    at(k, typeof get(value, k) === "string" && get(value, k) !== "", "missing");
  }
  for (const k of ["environment.cpu", "environment.os", "environment.node", "environment.grade"]) {
    at(k, typeof get(value, k) === "string" && get(value, k) !== "", "missing");
  }
  positive("environment.logicalCores");
  positive("args.sources");
  positive("args.queries");
  at("provider.kind", get(value, "provider.kind") === "stub", "must be stub");
  at("judgement", typeof get(value, "judgement") === "string", "missing");
  const json = JSON.stringify(value);
  at("verdict", !/"(pass|passed|fail|failed|verdict)"/.test(json), "a result does not judge");
  const keys = Object.keys(SYSTEM_THRESHOLDS) as ThresholdKey[];
  const metricKey: Record<ThresholdKey, string> = {
    installerSize: "installerSize",
    idleCpu: "idleCpu",
    idleMemory: "idleRss",
    processingSearchable: "processingSearchable",
    processingExtracted: "processingExtracted",
    search: "search",
    llmCalls: "llmCalls",
    storage: "storage",
    killRecover: "killRecover",
    soak: "soak",
  };
  for (const key of keys) {
    const path = `metrics.${metricKey[key]}`;
    const status = get(value, `${path}.status`);
    at(
      path,
      status === "measured" || status === "not-measured",
      "status must be measured or not-measured",
    );
    const row = SYSTEM_THRESHOLDS[key];
    at(
      `${path}.threshold`,
      get(value, `${path}.threshold.label`) === row.label &&
        get(value, `${path}.threshold.text`) === row.text,
      "threshold text differs from EVALUATION 4.4",
    );
    if (status === "not-measured") {
      at(
        `${path}.reason`,
        typeof get(value, `${path}.reason`) === "string" && get(value, `${path}.reason`) !== "",
        "a not-measured cell names its reason",
      );
    }
  }
  const measured = (path: string) => get(value, `${path}.status`) === "measured";
  if (measured("metrics.idleCpu")) nonNegative("metrics.idleCpu.percentOfAllCores");
  if (measured("metrics.idleRss")) positive("metrics.idleRss.medianMiB");
  for (const m of ["processingSearchable", "processingExtracted", "search"]) {
    if (measured(`metrics.${m}`)) {
      positive(`metrics.${m}.p50Ms`);
      positive(`metrics.${m}.p95Ms`);
    }
  }
  if (measured("metrics.llmCalls")) {
    positive("metrics.llmCalls.total");
    positive("metrics.llmCalls.perDocAvg");
  }
  if (measured("metrics.storage")) positive("metrics.storage.growthRatio");
  if (measured("metrics.killRecover")) {
    positive("metrics.killRecover.runningAtKill");
    positive("metrics.killRecover.firstJobAfterRestartMs");
    positive("metrics.killRecover.allJobsDoneMs");
    nonNegative("metrics.killRecover.lostDocs");
    nonNegative("metrics.killRecover.duplicateItems");
  }
  const unverified = get(value, "unverified");
  const items = Array.isArray(unverified)
    ? (unverified as { item?: string; reason?: string }[])
    : [];
  for (const fixed of FIXED_UNVERIFIED) {
    at(
      "unverified",
      items.some((u) => u.item === fixed.item && !!u.reason),
      `lacks "${fixed.item}"`,
    );
  }
  for (const key of keys) {
    const m = get(value, `metrics.${metricKey[key]}`) as { status?: string } | undefined;
    if (m?.status === "not-measured" && key !== "installerSize") {
      at("unverified", items.length > FIXED_UNVERIFIED.length, `lacks the not-measured ${key}`);
    }
  }
  return problems;
}

const FIXED_UNVERIFIED: readonly { item: string; reason: string }[] = [
  {
    item: "installer size",
    reason: "no installer is built here; the R04 kit and H03-C3 measure it (#33, #37)",
  },
  {
    item: "Windows 11 installed build",
    reason: "this run is a source run on the host machine, not the installed Windows build",
  },
  {
    item: "real Provider",
    reason:
      "call counts and extraction times are the stub's; a real model's retries and latency are unknown",
  },
  { item: "multi-hour soak", reason: "a soak of 72 hours, or even one hour, was not run" },
] as const;

// ---------------------------------------------------------------- small helpers

/** Nearest-rank percentile of an ascending list (tooling/poc/i02b/local-files-latency.ts). */
export function percentile(sortedAscending: number[], p: number): number {
  return sortedAscending[
    Math.min(sortedAscending.length - 1, Math.ceil(p * sortedAscending.length) - 1)
  ] as number;
}
const latencyOf = (ms: number[]): Latency => {
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = () => performance.now();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the stub's answer (D6)

/** One knowledge item and one fact per document, quoting STUB_QUOTE; an existing item of that name is reused. */
export function stubExtraction(request: StructuredRequest) {
  const candidate = request.input.candidates.find((c) => c.name === STUB_ITEM_NAME);
  return {
    items: [
      { ref: "A", type: "Project", name: STUB_ITEM_NAME, existingItemId: candidate?.id ?? null },
    ],
    facts: [
      {
        item: "A",
        kind: "target_date",
        value: "2026-12-05",
        epistemic: "explicit" as const,
        quote: STUB_QUOTE,
      },
    ],
    relations: [],
    terms: [],
    definitions: [],
    proposedTypes: [],
  };
}

// ---------------------------------------------------------------- synthetic documents

export interface SyntheticDoc {
  index: number;
  /** The one search word only this document holds. */
  token: string;
  externalId: string;
  line: string;
  bytes: number;
}
const FILLER = [
  "일정",
  "점검",
  "회의",
  "공유",
  "검토",
  "배포",
  "지표",
  "문서",
  "담당",
  "결정",
  "요청",
  "확인",
];

/** `count` documents of about `docBytes` bytes of UTF-8 text, the same for the same seed. */
export function makeDocs(count: number, docBytes: number, seed: number): SyntheticDoc[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, (_, index) => {
    const token = `zq${String(index).padStart(6, "0")}`;
    let content = `합성 자료입니다.\n\n${STUB_QUOTE}. 검색 표지 ${token}.\n\n`;
    while (Buffer.byteLength(content) < docBytes) {
      const words = Array.from({ length: 12 }, () => FILLER[Math.floor(random() * FILLER.length)]);
      content += `${words.join(" ")}.\n\n`;
    }
    const externalId = `meas-${token}`;
    const record = {
      id: externalId,
      source_type: "wiki",
      external_id: externalId,
      title: `합성 문서 ${token}`,
      content,
      author: "writer@example.test",
      participants: [],
      thread_id: "",
      source_url: `https://wiki.example.test/${externalId}`,
      created_at: "2026-11-03T10:00:00+09:00",
      updated_at: "2026-11-03T10:00:00+09:00",
      content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      version: 1,
      access_scope: ["group:measure"],
      metadata: {},
      connector_instance_id: INSTANCE,
      operation: "upsert",
      schema_version: "1",
    };
    return {
      index,
      token,
      externalId,
      line: JSON.stringify(record),
      bytes: Buffer.byteLength(content),
    };
  });
}

// ---------------------------------------------------------------- the backend as a child process

interface Route<T> {
  method: string;
  path: string;
  response: { parse: (value: unknown) => T };
}
export interface Backend {
  child: ChildProcess;
  pid: number;
  call<T>(route: Route<T>, body?: unknown): Promise<T>;
  stderr(): string;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function killGroup(pid: number): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // already gone
  }
}

interface StartOptions {
  mode: RunMode;
  workDir: string;
  dataDir: string;
  delayMs: number;
  leaseMs?: number;
  pids: number[];
}

async function startBackend(options: StartOptions): Promise<Backend> {
  const ready = join(options.workDir, `ready-${options.pids.length}`);
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: options.workDir,
    TMPDIR: options.workDir,
    PKI_MEASURE_DATA_DIR: options.dataDir,
    PKI_MEASURE_DELAY_MS: String(options.delayMs),
    PKI_MEASURE_READY: ready,
    ...(options.leaseMs === undefined ? {} : { PKI_MEASURE_LEASE_MS: String(options.leaseMs) }),
  };
  const args =
    options.mode === "source-run"
      ? [CHILD]
      : [VITEST, "run", "--config", CHILD_CONFIG, "--root", ROOT];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: process.platform !== "win32", // its own process group: what it leaves behind is found by that
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
  const pid = child.pid as number;
  options.pids.push(pid);
  let err = "";
  child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const deadline = ms() + SOURCE_TIMEOUT_MS;
  while (!existsSync(ready)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the backend exited before it was ready: ${err.trim()}`);
    }
    if (ms() > deadline) {
      killGroup(pid);
      throw new Error("timed out waiting for the backend to start");
    }
    await sleep(50);
  }
  const { url, token } = JSON.parse(readFileSync(ready, "utf8")) as { url: string; token: string };
  const call = async <T>(route: Route<T>, body?: unknown): Promise<T> => {
    const res = await fetch(`${url}${route.path}`, {
      method: route.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${route.method} ${route.path} answered ${res.status}`);
    return route.response.parse(await res.json());
  };
  return { child, pid, call, stderr: () => err };
}

async function stopBackend(backend: Backend): Promise<void> {
  const exited = new Promise<void>((r) =>
    backend.child.exitCode !== null || backend.child.signalCode !== null
      ? r()
      : backend.child.once("exit", () => r()),
  );
  killGroup(backend.pid);
  await exited;
}

/** What the user records in Settings: consent for the stub's class and the stub as the default Provider. */
async function bindStub(backend: Backend): Promise<void> {
  const list = await backend.call(routes.consents);
  const shown = list.providers.find((p) => p.providerId === STUB_PROVIDER_ID);
  if (!shown) throw new Error(`the backend lists no ${STUB_PROVIDER_ID} Provider`);
  await backend.call(routes.grantConsent, {
    providerId: STUB_PROVIDER_ID,
    allowedClasses: ["general"],
    destination: shown.destination ?? "",
    policyVersion: list.policyVersion,
  });
  await backend.call(routes.setDefaultProvider, { providerId: STUB_PROVIDER_ID });
}

const OPEN = ["queued", "running", "retry", "held"] as const;
const openJobs = (jobs: JobsResponse) => OPEN.reduce((n, s) => n + (jobs.counts[s] ?? 0), 0);

async function importDoc(backend: Backend, doc: SyntheticDoc): Promise<void> {
  const res = await backend.call(routes.importJsonl, { text: doc.line });
  if (res.errorCount > 0) {
    throw new Error(`the product refused a synthetic document: ${JSON.stringify(res.errors)}`);
  }
}

/** Waits until no job is open; a held job ends the wait with its reason code. */
async function waitDrained(backend: Backend, timeoutMs: number, what: string): Promise<void> {
  const deadline = ms() + timeoutMs;
  for (;;) {
    const jobs = await backend.call(routes.jobs);
    if (openJobs(jobs) === 0) return;
    const held = jobs.jobs.find((j) => j.status === "held");
    if (held)
      throw new Error(
        `a job is held (${held.kind}: ${held.reason ?? "no reason"}) waiting for ${what}`,
      );
    if (ms() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Searches until the document's own source is in the result; returns the elapsed milliseconds. */
async function searchFor(
  backend: Backend,
  doc: SyntheticDoc,
  query: string,
  within: number,
): Promise<number> {
  const started = ms();
  for (;;) {
    const found = await backend.call(routes.searchSources, { query });
    const elapsed = ms() - started;
    if (found.sources.some((s) => s.externalId === doc.externalId)) return elapsed;
    if (elapsed > within)
      throw new Error(`the document ${doc.externalId} is not in the results of "${query}"`);
    await sleep(10);
  }
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(path) : statSync(path).size;
  }
  return total;
}

// ---------------------------------------------------------------- external process samples (POSIX `ps`)

/** CPU seconds the process has used in total, read from outside (`ps`, hundredths on macOS; /proc on Linux). */
function cpuSeconds(pid: number): number {
  const stat = `/proc/${pid}/stat`;
  if (existsSync(stat)) {
    const fields = readFileSync(stat, "utf8")
      .slice(readFileSync(stat, "utf8").lastIndexOf(")") + 2)
      .split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100;
  }
  const text = execFileSync("ps", ["-o", "time=", "-p", String(pid)])
    .toString()
    .trim();
  const [days, clock] = text.includes("-") ? (text.split("-") as [string, string]) : ["0", text];
  const [h, m, s] = clock.split(":").length === 3 ? clock.split(":") : ["0", ...clock.split(":")];
  return Number(days) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
}
function rssMiB(pid: number): number {
  return (
    Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)])
        .toString()
        .trim(),
    ) / 1024
  );
}

// ---------------------------------------------------------------- phases

async function idlePhase(backend: Backend, seconds: number) {
  const startCpu = cpuSeconds(backend.pid);
  const started = ms();
  const rss: number[] = [];
  do {
    rss.push(rssMiB(backend.pid));
    await sleep(250);
  } while (ms() - started < seconds * 1000);
  const wall = (ms() - started) / 1000;
  const used = cpuSeconds(backend.pid) - startCpu;
  const sorted = [...rss].sort((a, b) => a - b);
  const short = seconds < 600;
  const shortNote = short
    ? `observed ${seconds} s; EVALUATION asks for a 10-minute idle, so this is shorter than the reference`
    : "observed at least the 10 minutes EVALUATION names";
  return {
    cpu: {
      status: "measured" as const,
      percentOfAllCores: (used / wall / cpus().length) * 100,
      observedSeconds: wall,
      note: `${shortNote}; the sample is CPU time over wall time across all logical cores`,
      threshold: thresholdOf("idleCpu"),
    },
    rss: {
      status: "measured" as const,
      minMiB: sorted[0] as number,
      medianMiB: percentile(sorted, 0.5),
      maxMiB: sorted.at(-1) as number,
      observedSeconds: wall,
      note: `${shortNote}; the embedding model is not loaded in this run`,
      threshold: thresholdOf("idleMemory"),
    },
  };
}

async function itemsNamed(backend: Backend, name: string): Promise<number> {
  let count = 0;
  let after: number | undefined;
  for (;;) {
    const page = await backend.call(routes.exploreItems, {
      query: name,
      ...(after === undefined ? {} : { after }),
    });
    count += page.items.filter((i) => i.name === name).length;
    if (page.next === null) return count;
    after = page.next;
  }
}

async function countCalls(
  backend: Backend,
): Promise<{ total: number; byTaskKind: Record<string, number> }> {
  const byTaskKind: Record<string, number> = {};
  let total = 0;
  let before: number | undefined;
  for (;;) {
    const page = await backend.call(routes.activityPage, before === undefined ? {} : { before });
    for (const call of page.calls) {
      total++;
      byTaskKind[call.taskKind] = (byTaskKind[call.taskKind] ?? 0) + 1;
    }
    if (page.next === null) return { total, byTaskKind };
    before = page.next;
  }
}

export interface KillOptions {
  mode: RunMode;
  /** The test build's job lease; ignored (the product's 2 minutes) by a source run. */
  leaseMs?: number;
  docs?: number;
  seed?: number;
  /** Receives every child pid and the work folder, for the caller's leftovers check. */
  trace?: { pids: number[]; workDir?: string };
}

/**
 * R7: kills the backend (SIGKILL) while an extraction job runs, starts it again on the same data folder, sends
 * the same documents again and times the recovery. POSIX only. Cleans up after itself.
 */
export async function runKillPhase(options: KillOptions): Promise<KillRecoverValue> {
  if (process.platform === "win32") throw new Error("the kill phase needs POSIX process groups");
  const docs = makeDocs(options.docs ?? KILL_DOCS, 10_000, options.seed ?? 1);
  const workDir = mkdtempSync(join(tmpdir(), "pki-measure-kill-"));
  const pids = options.trace?.pids ?? [];
  if (options.trace) options.trace.workDir = workDir;
  const dataDir = join(workDir, "data");
  const start = (backendOptions: Partial<StartOptions> = {}) =>
    startBackend({
      mode: options.mode,
      workDir,
      dataDir,
      delayMs: KILL_DELAY_MS,
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      pids,
      ...backendOptions,
    });
  let backend: Backend | undefined;
  try {
    backend = await start();
    await bindStub(backend);
    for (const doc of docs) await importDoc(backend, doc);
    const deadline = ms() + SOURCE_TIMEOUT_MS;
    let before = await backend.call(routes.jobs);
    while ((before.counts.running ?? 0) === 0) {
      if (ms() > deadline) throw new Error("no extraction job ran before the kill");
      await sleep(20);
      before = await backend.call(routes.jobs);
    }
    const runningAtKill = before.counts.running ?? 0;
    const attemptsAtKill = new Map(before.jobs.map((j) => [j.id, j.attempts]));
    const succeededAtKill = before.counts.succeeded ?? 0;
    await stopBackend(backend);
    if (groupAlive(backend.pid)) throw new Error("the killed backend left a process behind");

    backend = await start();
    const restarted = ms();
    for (const doc of docs) await importDoc(backend, doc); // the same documents again
    let firstJobAfterRestartMs: number | undefined;
    const waitEnd = ms() + KILL_WAIT_MS;
    for (;;) {
      const jobs = await backend.call(routes.jobs);
      if (
        firstJobAfterRestartMs === undefined &&
        ((jobs.counts.succeeded ?? 0) > succeededAtKill ||
          jobs.jobs.some((j) => j.attempts > (attemptsAtKill.get(j.id) ?? 0)))
      ) {
        firstJobAfterRestartMs = ms() - restarted;
      }
      if (openJobs(jobs) === 0) break;
      const held = jobs.jobs.find((j) => j.status === "held");
      if (held)
        throw new Error(
          `a job is held (${held.kind}: ${held.reason ?? "no reason"}) after the restart`,
        );
      if (ms() > waitEnd) throw new Error("the jobs did not finish after the restart");
      await sleep(100);
    }
    const allJobsDoneMs = ms() - restarted;
    let lostDocs = 0;
    for (const doc of docs) {
      const found = await backend.call(routes.searchSources, { query: doc.token });
      if (!found.sources.some((s) => s.externalId === doc.externalId)) lostDocs++;
    }
    const names = await itemsNamed(backend, STUB_ITEM_NAME);
    const leaseMs = options.mode === "test-build" ? (options.leaseMs ?? 0) : 120_000;
    return {
      leaseMs,
      leaseSource: options.mode === "test-build" ? "test build override" : "product default",
      docs: docs.length,
      runningAtKill,
      firstJobAfterRestartMs: firstJobAfterRestartMs ?? allJobsDoneMs,
      allJobsDoneMs,
      lostDocs,
      duplicateItems: Math.max(0, names - 1),
      note: "firstJobAfterRestartMs is the time from the restart to the first job to run (any job); allJobsDoneMs to every job finished, the interrupted job included, which waits for its lease to run out",
    };
  } finally {
    if (backend) await stopBackend(backend);
    for (const pid of pids) killGroup(pid);
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the measurement

export interface MeasurementOptions {
  sources: number;
  queries: number;
  warmup: number;
  idleSeconds: number;
  soakSeconds: number;
  skipKill: boolean;
  docBytes?: number;
  stubDelayMs?: number;
  seed?: number;
  /** The query for the document a query is about; default its own search word. A test makes it wrong. */
  queryFor?: (doc: SyntheticDoc) => string;
  /** Runs while the backend still stands, before the data folder goes. */
  onBeforeCleanup?: (dataDir: string) => void;
}
export interface MeasurementRun {
  result: MeasurementResult;
  trace: { pids: number[]; workDir: string; rawBytes: number };
}

const git = (...args: string[]) =>
  spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).stdout.trim();

export async function runMeasurement(options: MeasurementOptions): Promise<MeasurementRun> {
  if (options.queries <= options.warmup)
    throw new Error("queries must exceed the warm-up queries, or nothing is timed");
  const docBytes = options.docBytes ?? 10_000;
  const stubDelayMs = options.stubDelayMs ?? DEFAULT_DELAY_MS;
  const seed = options.seed ?? 1;
  const posix = process.platform !== "win32";
  const docs = makeDocs(options.sources, docBytes, seed);
  const queryFor = options.queryFor ?? ((doc: SyntheticDoc) => doc.token);
  const workDir = mkdtempSync(join(tmpdir(), "pki-measure-"));
  const dataDir = join(workDir, "data");
  const pids: number[] = [];
  const ranAt = new Date().toISOString();
  let backend: Backend | undefined;
  try {
    backend = await startBackend({
      mode: "source-run",
      workDir,
      dataDir,
      delayMs: stubDelayMs,
      pids,
    });
    await bindStub(backend);
    const emptyDataDirBytes = dirBytes(dataDir);

    // ingest: one document at a time, timing searchable and extracted
    const searchable: number[] = [];
    const extracted: number[] = [];
    const points: { sources: number; dataDirBytes: number; rawBytes: number }[] = [];
    const every = Math.max(1, Math.ceil(docs.length / 10));
    let rawBytes = 0;
    for (const doc of docs) {
      const started = ms();
      await importDoc(backend, doc);
      await searchFor(backend, doc, doc.token, 10_000);
      searchable.push(ms() - started);
      await waitDrained(backend, SOURCE_TIMEOUT_MS, `extraction of ${doc.externalId}`);
      extracted.push(ms() - started);
      rawBytes += doc.bytes;
      if ((doc.index + 1) % every === 0 || doc.index === docs.length - 1) {
        points.push({ sources: doc.index + 1, dataDirBytes: dirBytes(dataDir), rawBytes });
      }
    }

    // search: each query's own document must be in its results, or nothing is timed
    const queryMs: number[] = [];
    for (let i = 0; i < options.queries; i++) {
      const doc = docs[i % docs.length] as SyntheticDoc;
      const query = queryFor(doc);
      const started = ms();
      const found = await backend.call(routes.searchSources, { query });
      const elapsed = ms() - started;
      if (!found.sources.some((s) => s.externalId === doc.externalId)) {
        throw new Error(`the document ${doc.externalId} is not in the results of "${query}"`);
      }
      if (i >= options.warmup) queryMs.push(elapsed);
    }

    const calls = await countCalls(backend);
    const last = points.at(-1) as { dataDirBytes: number; rawBytes: number };

    // idle: the jobs are done; sample from outside
    const idle = posix ? await idlePhase(backend, options.idleSeconds) : undefined;

    // soak: ingest and search again for the given time
    let soak: MeasurementResult["metrics"]["soak"];
    if (options.soakSeconds > 0 && posix) {
      const extra = makeDocs(options.sources + 100_000, 2_000, seed + 1).slice(options.sources);
      const rssStartMiB = rssMiB(backend.pid);
      const started = ms();
      let documentsAdded = 0;
      let searches = 0;
      let crashes = 0;
      while (ms() - started < options.soakSeconds * 1000) {
        if (backend.child.exitCode !== null || backend.child.signalCode !== null) {
          crashes++;
          break;
        }
        const doc = extra[documentsAdded] as SyntheticDoc;
        await importDoc(backend, doc);
        await searchFor(backend, doc, doc.token, 10_000);
        searches++;
        documentsAdded++;
        await waitDrained(backend, SOURCE_TIMEOUT_MS, "the soak's extraction");
      }
      soak = {
        status: "measured",
        seconds: (ms() - started) / 1000,
        documentsAdded,
        searches,
        crashes,
        rssStartMiB,
        rssEndMiB: crashes === 0 ? rssMiB(backend.pid) : 0,
        threshold: thresholdOf("soak"),
      };
    } else {
      soak = notMeasured(
        "soak",
        "soak seconds is 0 (the default): a soak is run on request (--soak-seconds)",
      );
    }
    options.onBeforeCleanup?.(dataDir);
    await stopBackend(backend);
    backend = undefined;

    // forced kill and recovery: its own backend, the product's lease
    let killRecover: MeasurementResult["metrics"]["killRecover"];
    if (options.skipKill) {
      killRecover = notMeasured("killRecover", "left out on request (--skip-kill)");
    } else if (!posix) {
      killRecover = notMeasured(
        "killRecover",
        "the kill phase needs POSIX process groups; Windows is unverified (D9)",
      );
    } else {
      const trace = { pids };
      killRecover = {
        status: "measured",
        ...(await runKillPhase({ mode: "source-run", seed, trace })),
        threshold: thresholdOf("killRecover"),
      };
    }

    const cpu = cpus();
    const metrics: MeasurementResult["metrics"] = {
      installerSize: notMeasured("installerSize", "no installer is built in this run"),
      idleCpu:
        idle?.cpu ?? notMeasured("idleCpu", "idle sampling reads `ps`; Windows is unverified (D9)"),
      idleRss:
        idle?.rss ??
        notMeasured("idleMemory", "idle sampling reads `ps`; Windows is unverified (D9)"),
      processingSearchable: {
        status: "measured",
        ...latencyOf(searchable),
        definition: "from sending the document to the import API until a keyword search returns it",
        threshold: thresholdOf("processingSearchable"),
      },
      processingExtracted: {
        status: "measured",
        ...latencyOf(extracted),
        definition:
          "from sending the document until every job is done (the stub answers after the stated delay); documents are sent one at a time, so no queue wait is in it",
        threshold: thresholdOf("processingExtracted"),
      },
      search: {
        status: "measured",
        ...latencyOf(queryMs),
        warmupDiscarded: options.warmup,
        definition:
          "one keyword-search request over HTTP, timed only when the query's own document is in the results",
        threshold: thresholdOf("search"),
      },
      llmCalls: {
        status: "measured",
        total: calls.total,
        byTaskKind: calls.byTaskKind,
        perDocAvg: calls.total / docs.length,
        answeredBy: "stub",
        maxPerDoc: {
          status: "not-measured",
          reason: "the call history carries no document number (D8)",
        },
        perQaQuestion: {
          status: "not-measured",
          reason: "Q&A needs an answer double of its own (D8)",
        },
        daily: { status: "not-measured", reason: "no day of use was run (D8)" },
        threshold: thresholdOf("llmCalls"),
      },
      storage: {
        status: "measured",
        points,
        emptyDataDirBytes,
        growthRatio: (last.dataDirBytes - last.rawBytes) / last.rawBytes,
        definition:
          "(data folder bytes - raw text bytes) / raw text bytes at the last point; raw and derived data share one SQLite file, so the folder stands for the derived data (D7)",
        threshold: thresholdOf("storage"),
      },
      killRecover,
      soak,
    };

    const unverified = [...FIXED_UNVERIFIED].map((u) => ({ ...u }));
    for (const [item, metric] of [
      ["forced kill and recovery", metrics.killRecover],
      ["soak run", metrics.soak],
      ["idle CPU and RSS", metrics.idleCpu],
    ] as const) {
      if (metric.status === "not-measured") unverified.push({ item, reason: metric.reason });
    }
    const cpuModel = cpu[0]?.model ?? "unknown";
    const result: MeasurementResult = {
      schemaVersion: 1,
      ranAt,
      productCommit: git("rev-parse", "HEAD"),
      workingTreeClean: git("status", "--porcelain", "--", ".", ":!eval/results") === "",
      mode: "source-run",
      environment: {
        cpu: cpuModel,
        logicalCores: cpu.length,
        ramGiB: Math.round(totalmem() / 2 ** 30),
        os: `${osType()} ${release()} ${arch()}`,
        node: process.version,
        grade:
          "neither A nor B (EVALUATION 4.4 names Windows 11 machines): the values here are references, not a verdict",
      },
      args: {
        sources: options.sources,
        docBytes,
        queries: options.queries,
        warmupQueries: options.warmup,
        idleSeconds: options.idleSeconds,
        soakSeconds: options.soakSeconds,
        skipKill: options.skipKill,
        stubDelayMs,
        jobLeaseMs: 120_000,
        seed,
      },
      provider: {
        kind: "stub",
        meaning:
          "a test double answers every extraction with one fixed, schema-valid knowledge line quoting the document; call counts and extraction times are the stub's, not a real model's",
      },
      judgement:
        "none: thresholds are EVALUATION 4.4's, copied beside each value; they are judged only on grade A hardware with corpus T2 and a real Provider (D2)",
      metrics,
      unverified,
    };
    return { result, trace: { pids, workDir, rawBytes } };
  } finally {
    if (backend) await stopBackend(backend);
    for (const pid of pids) killGroup(pid);
    rmSync(workDir, { recursive: true, force: true });
  }
}
