# FALDA unified server image — multi-stage build.
#
# The builder stage compiles TypeScript and the better-sqlite3 native addon
# under the exact Node version the runtime stage uses (both node:24), so the
# addon's ABI always matches at container start — the "NODE_MODULE_VERSION
# mismatch" trap documented in docs/HARNESS_INTEGRATION.md and
# deploy/launchd/*.plist.template (REPLACE_ME_NODE) doesn't apply here since
# build and run are pinned to the same base image.
#
# Runs `node dist/server.js` — `falda serve` (src/server.ts): the HTTP JSON
# API, the MCP endpoint, the background distillation worker, and recall-trace
# pruning, all in one process against one shared runtime (src/runtime.ts).
# See docs/MCP.md / docs/API.md for the two protocol surfaces' auth model and
# route/tool tables, and integrations/opencode/README.md for the Docker
# Compose recipe (multi-agent deployment against one FALDA instance).

# ---- builder ----
FROM node:24-trixie AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:24-trixie-slim AS runtime

# FALDA_BIND/FALDA_MCP_BIND default to loopback-only outside a container
# (see docs/future/reliability-hardening.md finding 11), but this image is
# meant to be reached via `docker run -p 127.0.0.1:PORT:PORT ...` /
# compose port publishing, which connects to the container's own address —
# not its loopback interface. So both are set to 0.0.0.0 here; the
# loopback-only guarantee for a published port comes from the publish spec
# (e.g. "127.0.0.1:8079:8079"), not from this image binding loopback
# internally.
ENV NODE_ENV=production \
    FALDA_ROOT=/data \
    FALDA_PORT=8077 \
    FALDA_MCP_PORT=8079 \
    FALDA_BIND=0.0.0.0 \
    FALDA_MCP_BIND=0.0.0.0 \
    FALDA_TOKENS=/run/falda/tokens.json \
    FALDA_EMBED=local \
    FALDA_DIM=768

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8077 8079

CMD ["node", "dist/server.js"]
