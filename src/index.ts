/**
 * FALDA — clustered hierarchical memory for scientific agents.
 * Public API barrel.
 */
export { Falda } from "./falda.js";
export type {
  FaldaOptions, Embedder, RecallWeights,
  StreamItem, StreamHit, AddStreamResult,
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
export { TokenStore, AuthError, parseBearer } from "./mcp_auth.js";
export type { Principal } from "./mcp_auth.js";
export { distillOnce } from "./distill/core.js";
export type { LLMFn, DistillOptions, DistillResult } from "./distill/core.js";
export { assembleContext } from "./distill/context.js";
export type { AssembledContext, TierBudgets } from "./distill/context.js";
export { enqueue, getJob, getJobAuthorized, storeKeyFor, listJobs } from "./distill/queue.js";
export type { DistillJob, JobStatus } from "./distill/queue.js";
