/**
 * FALDA — clustered hierarchical memory for scientific agents.
 * Public API barrel.
 */
export { Falda } from "./falda.js";
export type {
  FaldaOptions, Embedder, StreamItem, StreamHit, Atom, AtomHit, SceneEntry,
} from "./falda.js";
export { makeEmbedder, makeLocalEmbedder } from "./embedder.js";
export type { EmbedderConfig } from "./embedder.js";
export { PoolManager, PoolError } from "./pools.js";
export type { Access, PoolDecl } from "./pools.js";
export { makeFaldaMcpServer, handleFaldaMcpRequest } from "./mcp.js";
export { TokenStore, AuthError, parseBearer } from "./mcp_auth.js";
export type { Principal } from "./mcp_auth.js";
