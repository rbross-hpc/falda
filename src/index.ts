/**
 * FALDA — clustered hierarchical memory for scientific agents.
 * Public API barrel.
 */
export { Falda } from "./falda.js";
export type {
  FaldaOptions, Embedder, RecallWeights,
  StreamItem, StreamHit, StreamTurn, AddStreamResult,
  Atom, AtomHit, AtomType, AtomStatus, AtomConfidence,
  Scene, SceneHit, SceneKind, SceneStatus,
  EvidenceEdge,
} from "./falda.js";
export {
  VALID_ATOM_TYPES, VALID_CONFIDENCE,
  StreamConflictError, AtomImmutabilityError, AtomTypeError,
} from "./falda.js";
export { makeEmbedder, makeLocalEmbedder } from "./embedder.js";
export type { EmbedderConfig } from "./embedder.js";
export { PoolManager, PoolError } from "./pools.js";
export type { Access, PoolDecl } from "./pools.js";
export { makeFaldaMcpServer, handleFaldaMcpRequest } from "./mcp.js";
export { DEFAULT_TOOLS, ADVANCED_TOOLS, FULL_TOOLS, toolsFor, resolveToolset } from "./mcp/registry.js";
export type { ToolDef, ToolsetName } from "./mcp/registry.js";
export { TokenStore, AuthError, parseBearer } from "./mcp_auth.js";
export type { Principal } from "./mcp_auth.js";
export { distillOnce } from "./distill/core.js";
export type { LLMFn, DistillOptions, DistillResult } from "./distill/core.js";
export { assembleContext } from "./distill/context.js";
export type {
  AssembledContext, TierBudgets, RecallItem, RecallItemSource, RecallItemKind,
  /** @deprecated use RecallItem */
  ContextHit,
} from "./distill/context.js";
export { enqueue, getJob, getJobAuthorized, storeKeyFor, listJobs, PRIORITY_PASSIVE, PRIORITY_EXPLICIT } from "./distill/queue.js";
export type { DistillJob, JobStatus, JobOrigin, EnqueueOptions, ClaimOptions } from "./distill/queue.js";
export { startDistiller, resolveWorkerIntervals } from "./distill/worker.js";
export type { DistillerHandle, DistillerOptions } from "./distill/worker.js";
export { Histogram, TaggedHistogram, MetricsRegistry, DEFAULT_BUCKET_BOUNDS_MS } from "./metrics.js";
export type { HistogramBucket, HistogramSnapshot, TaggedHistogramSnapshot, MetricsSnapshot } from "./metrics.js";
export { renderHistogram, renderMetricsSnapshot } from "./metrics_render.js";
export {
  buildStatsReport, renderHuman as renderStatsHuman, listAllStores, inspectStore,
} from "./stats.js";
export type {
  StatsOptions, StatsReport, Section as StatsSection, TimingReport,
  StoreRef, StoreReport, StoreReportError, QueueReport, RecallReport, LayoutReport,
} from "./stats.js";
export { initRecallTraceSchema } from "./recall/schema.js";
export { createRecallTrace, getRecallTraceAuthorized } from "./recall/traces.js";
export { reportRecallUsage } from "./recall/usage.js";
export { computeRecallMetrics } from "./recall/metrics.js";
export { pruneRecallTraces, resolveRetentionDays, DEFAULT_RETENTION_DAYS } from "./recall/retention.js";
export { buildPolicySnapshot, RETRIEVAL_POLICY_VERSION } from "./recall/policy.js";
export { RecallTraceError } from "./recall/types.js";
export type {
  UsageState, PolicySnapshot, RecallTrace, RecallTraceItemRow, ItemRef,
  CreateRecallTraceInput, RecallTraceView, ReportUsageResult,
} from "./recall/types.js";
export type { RecallMetrics, UsageRate } from "./recall/metrics.js";
