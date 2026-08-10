# FALDA MCP server image — multi-stage build.
#
# The builder stage compiles TypeScript and the better-sqlite3 native addon
# under the exact Node version the runtime stage uses (both node:24), so the
# addon's ABI always matches at container start — the "NODE_MODULE_VERSION
# mismatch" trap documented in docs/HARNESS_INTEGRATION.md and
# deploy/launchd/*.plist.template (REPLACE_ME_NODE) doesn't apply here since
# build and run are pinned to the same base image.
#
# Runs `node dist/mcp.js` (the compiled MCP server, src/mcp.ts) — NOT the
# JSON gateway. See docs/MCP.md for the auth model and tool table, and
# integrations/opencode/README.md for the Docker Compose recipe.

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

ENV NODE_ENV=production \
    FALDA_ROOT=/data \
    FALDA_MCP_PORT=8079 \
    FALDA_MCP_TOKENS=/run/falda/tokens.json \
    FALDA_EMBED=local \
    FALDA_DIM=768

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8079

CMD ["node", "dist/mcp.js"]
