export { send, sendRaw, type TestResponse } from "./http.ts";
export { seedLegacyTombstone } from "./tombstone-seed.ts";
export { setOntologyStatusForTest, setStatusForTest } from "./knowledge-status-seed.ts";
export { canariesLeft, findCanaries, type CanaryHit } from "./canary-files.ts";
export { sqlDriverContract, type ContractSqlDriver } from "./sql-driver.contract.ts";
export { knowledgeEngineContract } from "./engine.contract.ts";
export { MemoryKnowledgeEngine } from "./memory-knowledge-engine.ts";
export { ProposingKnowledgeEngine, type Proposer } from "./proposing-knowledge-engine.ts";
export { MemoryVectorIndex } from "./memory-vector-index.ts";
export { vectorIndexContract } from "./vector-index.contract.ts";
export {
  CONNECTOR_VIOLATION_CODES,
  checkConnector,
  connectorContract,
  type ConnectorCheckCode,
  type ConnectorScenario,
  type ConnectorViolationCode,
} from "./connector.contract.ts";
export {
  ScriptedConnector,
  type ConnectorScript,
  type ScriptCall,
  type ScriptedConnectorOptions,
  type ScriptEntry,
  type ScriptFault,
} from "./scripted-connector.ts";
export {
  DERIVATIVE_CONTRACT_CASES,
  derivativeKindContract,
  type ContractDerivativeKind,
  type ContractRegistrar,
  type ContractDerivedRef,
  type ContractSourceVersionRef,
  type DerivativeContractCase,
  type DerivativeContractFixture,
  type DerivativeContractSubject,
} from "./derivatives.contract.ts";
export { embeddingContract, type EmbeddingContractSubject } from "./embedding.contract.ts";
export { FakeEmbedder, type FakeEmbedderOptions } from "./fake-embedder.ts";
export { FakeProvider, type FakeProviderOptions, type FakeStep } from "./fake-provider.ts";
export { providerContract, providerRequest, structuredRequest } from "./provider.contract.ts";
export {
  completion,
  defaultReply,
  startFakeOpenAI,
  type FakeHttpReply,
  type FakeHttpRequest,
  type FakeOpenAIServer,
} from "./fake-openai-server.ts";
export { newTempFilesContaining, tempEntries } from "./temp-scan.ts";
export { FakeEmbeddingRuntime, sha256Hex, writeModelPack, type PackFile } from "./model-pack.ts";
export { fixtureExtraction, type FixtureExtraction } from "./fixture-extraction.ts";
export {
  installFakeCli,
  processAlive,
  type FakeCli,
  type FakeCliConfig,
  type FakeCliMode,
  type FakeCliRun,
} from "./fake-cli.ts";
export { memoryLedgerIo, type LedgerIoOperation, type MemoryLedgerIo } from "./memory-ledger-io.ts";
export {
  TABULAR_CONTRACT_FIXTURES,
  csvVersion,
  tabularContract,
  type ContractColumn,
  type ContractTable,
  type ContractTableRead,
  type ContractTabularRead,
  type ContractTabularSource,
  type ContractVersionRef,
  type StoredTableVersion,
  type TabularContractFixture,
  type TabularContractHarness,
} from "./tabular.contract.ts";
export { MemoryTabularSource } from "./memory-tabular-source.ts";
