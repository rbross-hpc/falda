# Installing FALDA

FALDA is a self-contained TypeScript/Node package. It has two runtime
dependencies — `better-sqlite3` (embedded SQLite, with a native addon) and
`sqlite-vec` (vector search) — and runs fully offline by default.

## Requirements

- **Node.js 20–26** and npm (npm ships with Node). CI covers Node 20, 22, 24, and 26 on Linux and macOS.
- **No C toolchain needed for the common case.** `better-sqlite3` (>= 12) ships
  prebuilt binaries for macOS (arm64/x64) and Linux (arm64/x64) on supported Node
  versions, and `sqlite-vec` is distributed as a prebuilt extension — so a normal
  `npm install` does not compile anything.
- A C toolchain is only needed as a **fallback** if no prebuilt binary matches your
  platform/Node combo:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Linux:** `build-essential` + `python3` (e.g. `apt install build-essential python3`).
  - **Windows:** the windows-build-tools / Visual Studio C++ workload.

> Note: pin `better-sqlite3` to a release that supports your Node version. Versions
> < 12 predate Node 26 and will fall back to a native compile (and may fail) on
> newer Node. FALDA pins `^12.11.1` for this reason.

No external service is required to install or smoke-test. Embeddings are
optional and only contacted at runtime if you configure an embedder endpoint.

## Quick install

```bash
git clone <your-falda-remote> falda     # or copy the directory
cd falda
./install.sh
```

The installer:

1. verifies Node >= 20 and npm,
2. installs dependencies (`npm ci` when a lockfile is present),
3. builds TypeScript to `dist/`,
4. runs the offline smoke test (all four tiers + hybrid recall),
5. prints next steps.

### Put the CLI on your PATH

```bash
./install.sh --link                 # symlink bin/falda into /usr/local/bin or ~/.local/bin
./install.sh --link --prefix ~/bin  # choose the link target
```

### Other flags

```bash
./install.sh --no-smoke    # skip the smoke test (faster CI installs)
./install.sh --help
```

## Using the CLI

```bash
cp falda_tokens.example.json falda_tokens.json  # fill in real tokens; required
falda serve             # unified server: HTTP API (:8077) + MCP (:8079) + distillation worker
falda serve --no-mcp    # HTTP API + worker only, no MCP listener
falda health            # curl the HTTP API's /healthz (unauthenticated)
falda smoke             # re-run the offline smoke test
falda build             # recompile to dist/
falda stats             # read-only, offline report of everything under FALDA_ROOT (see docs/OPERATIONS.md)
falda reembed           # rebuild vector indexes after a model/dim change (see docs/OPERATIONS.md)
falda distill inspect   # review what a distillation pass actually decided (see docs/OPERATIONS.md)
falda show recall       # view a recall via the running server (see docs/OPERATIONS.md)
falda version
```

`falda serve` requires a bearer-token file (`FALDA_TOKENS`) and refuses to
boot without one — see `docs/API.md` "Authentication". This one token file
is shared by both the HTTP API and the MCP endpoint.

## Running in Docker

```bash
cp falda_tokens.example.json falda_tokens.json   # fill in real tokens
docker build -t local/falda:latest .
docker run -d --name falda \
  -p 127.0.0.1:8077:8077 -p 127.0.0.1:8079:8079 \
  -v falda-data:/data \
  -v "$PWD/falda_tokens.json:/run/falda/tokens.json:ro" \
  -e FALDA_EMBED=local \
  local/falda:latest

curl -s localhost:8077/healthz
curl -s localhost:8079/healthz
```

The image's default `CMD` is `node dist/server.js` (`falda serve`) — HTTP
API + MCP + the distillation worker + recall-trace pruning, all in one
container. `FALDA_ROOT=/data`, `FALDA_TOKENS=/run/falda/tokens.json`,
`FALDA_PORT=8077`, `FALDA_MCP_PORT=8079`, and `FALDA_EMBED=local` are baked
in as defaults (see the `Dockerfile`); override with `-e` as needed,
including `FALDA_LLM_*` to point distillation at a real chat model (see
`docs/API.md` "Distillation"). Both listeners default to binding
`127.0.0.1` outside a container — but binding loopback *inside* a
container defeats `docker -p` publishing (Docker's port-forwarding
connects to the container's own address, not its internal loopback
interface), so the image also bakes in `FALDA_BIND=0.0.0.0` and
`FALDA_MCP_BIND=0.0.0.0`. The loopback-only guarantee above comes entirely
from the `-p 127.0.0.1:PORT:PORT` publish spec in the `docker run`
command, not from anything the container binds internally — a bare
`-p 8077:8077` would expose it on every host interface.

Distillation speaks two providers, selected by `FALDA_LLM_PROVIDER`:
`openai` (the default — any OpenAI-compatible `/v1/chat/completions`
endpoint, so local Ollama, vLLM, and llama.cpp all qualify) and `anthropic`
(Anthropic's Messages API directly, with no compatibility shim in between).
With the variable unset, nothing changes from previous releases.

```bash
docker run -d --name falda \
  ...                                        # ports, volumes, tokens as above
  -e FALDA_LLM_PROVIDER=anthropic \
  -e FALDA_LLM_API_KEY="$ANTHROPIC_API_KEY" \
  local/falda:latest
```

`FALDA_LLM_MODEL` defaults per provider — `gpt-4o-mini` for `openai`,
`claude-haiku-4-5` for `anthropic` — so the API key is usually the only
variable you have to set. The README's "Distillation" section has the full
table; `docs/future/anthropic-llm-provider.md` explains why the provider is
a switch rather than a base-URL swap (Anthropic exposes no
OpenAI-compatible endpoint, so pointing `FALDA_LLM_BASE_URL` at it cannot
work).

For the "one FALDA instance behind several containerized agents" deployment
(Compose, shared network, per-project tenants), see
`integrations/opencode/README.md` §2b for the full recipe.

## Using it as a library

```bash
npm install falda-memory
```

```ts
import { Falda, makeLocalEmbedder } from "falda-memory";

const mem = new Falda({ db: ":memory:", embedder: makeLocalEmbedder(768) });
await mem.addStream({ agent: "kukla", role: "user", text: "remember this" });
const hits = await mem.recall("kukla", "what should I remember?");
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `FALDA_PORT` | `8077` | HTTP API listen port |
| `FALDA_MCP_PORT` | `8079` | MCP endpoint listen port |
| `FALDA_BIND` | `127.0.0.1` | HTTP API bind host — loopback-only by default; set `0.0.0.0` for `docker -p` reachability (the shipped image already does) |
| `FALDA_MCP_BIND` | `127.0.0.1` | MCP endpoint bind host — same loopback-only default/container caveat |
| `FALDA_MAX_BODY_BYTES` | `1048576` | Max HTTP request body size (bytes); oversized bodies get `413` before parsing/auth; `<= 0` disables the cap |
| `FALDA_ROOT` | `./falda-data` | Pool root dir (all tenant/pool stores) |
| `FALDA_TOKENS` | `./falda_tokens.json` | Canonical bearer-token file, shared by HTTP and MCP (required — see `docs/API.md`) |
| `FALDA_EMBED` | _(unset)_ | Embedder mode: `local` (deterministic, offline, **not semantic**), `onnx` (a real model in-process, no server), or `remote` (an OpenAI-compatible endpoint). Unset infers from `FALDA_EMBED_BASE_URL` — see the precedence list below |
| `FALDA_EMBED_BASE_URL` | _(unset)_ | OpenAI-compatible `/v1/embeddings` base URL |
| `FALDA_EMBED_API_KEY` | _(unset)_ | API key for the embedder, if required |
| `FALDA_EMBED_MODEL` | `nomic-embed-text` | Embedding model id (`Xenova/bge-base-en-v1.5` when `FALDA_EMBED=onnx`) |
| `FALDA_EMBED_STRICT` | _(unset)_ | `1` turns an unconfigured embedder (no `FALDA_EMBED`/`FALDA_EMBED_BASE_URL`) into a startup `FATAL` instead of the silent local-embedder fallback below — opt in for production |
| `FALDA_DISTILL_CONSOLIDATION_BATCH` | `20` | candidates decided per consolidation call. Distillation decides them in batches of this size instead of one call each — an estimated ~47% fewer input tokens at 15 candidates. `1` restores one call per candidate |
| `FALDA_DISTILL_CONSOLIDATION_MAX_CHARS` | *(disabled)* | approximate char cap (~4 chars/token heuristic, not an exact token count) on one batched consolidation call's built prompt; over-cap chunks are adaptively split smaller (down to one candidate, sent alone if it alone still exceeds the cap). Disabled (`0`) by default; set a positive value if large `FALDA_DISTILL_CONSOLIDATION_BATCH` values risk exceeding your model's input window |

`FALDA_DB` (a single store's SQLite path) applies only when embedding
`Falda` directly as a library, not to `falda serve`, which always addresses
stores through `FALDA_ROOT` + the pool layer.

With no embedder configured, FALDA uses a built-in **deterministic local
embedder** so `falda serve` and all four tiers work fully offline out of the
box. Be clear about what that is, though: it hashes character positions
rather than modelling meaning, so dense recall contributes nothing and only
FTS5/BM25 does real retrieval. It is a placeholder that keeps the system
running, not a working embedder.

Two ways to get a real one:

- **`FALDA_EMBED=onnx`** — runs a sentence-embedding model *inside* the FALDA
  process through ONNX Runtime. No server, no daemon, no network at query
  time. Costs one `npm install @huggingface/transformers` (~380MB) and a
  one-time model download (~440MB, cached). See the README's
  "A real model with no server" section.
- **`FALDA_EMBED_BASE_URL`** (or `FALDA_EMBED=remote`) — an OpenAI-compatible
  `/v1/embeddings` service: local Ollama, self-hosted vLLM/llama.cpp, or a
  hosted endpoint. Adds a deployment step; adds no dependency.

Embedder selection precedence (all server entry points, via `src/runtime.ts`):

- `FALDA_EMBED=local` → force the offline deterministic embedder.
- `FALDA_EMBED=onnx` → run a real model in-process via ONNX Runtime (no server; requires `npm install @huggingface/transformers`).
- `FALDA_EMBED=remote` → require a configured `/v1/embeddings` endpoint.
- unset + `FALDA_EMBED_BASE_URL` present → remote.
- unset + no base URL → offline local default (unless `FALDA_EMBED_STRICT=1`, which makes this case a startup FATAL instead — see `docs/OPERATIONS.md` "Startup embedding verification").

An explicit `FALDA_EMBED` always wins: `FALDA_EMBED=onnx` is used even when
`FALDA_EMBED_BASE_URL` is also set.

Every server entry point also probes the configured embedder once at boot
(calls it, checks the returned vector's length against `FALDA_DIM`) before
locking that config into `EMBEDDING.json`. Both `remote` and `onnx` are
probed; the deterministic `local` embedder is not, having nothing to reach.
A down endpoint, an uninstalled `@huggingface/transformers`, or a
model/dimension mismatch fails boot immediately rather than corrupting
recall later. Changing `FALDA_EMBED_MODEL`/`FALDA_DIM` on a store that
already has data requires `falda reembed` to rebuild its vector indexes
first — see `docs/OPERATIONS.md` "Re-embedding after a model/dimension
change".

> **Native addon / Node pinning.** `better-sqlite3` compiles a native addon
> against the Node.js ABI of whatever `node` ran `npm install`. If you later
> run `falda serve` under a *different* Node major version you may see
> `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch. Fix: run FALDA under
> the same Node you installed with, or rebuild with `npm rebuild better-sqlite3`.
>
> The same applies to `onnxruntime-node`, pulled in by
> `@huggingface/transformers` if you opt into `FALDA_EMBED=onnx` (see
> `README.md`). It ships prebuilt binaries for macOS, Linux and Windows, so a
> normal install compiles nothing — but it is a second native addon with the
> same Node-version pinning caveat. It is an **optional dependency, declared
> nowhere in `package.json`**: nothing installs it unless you ask for it, so
> deployments using `local` or `remote` embedders are unaffected.

## Uninstall

```bash
rm -f /usr/local/bin/falda ~/.local/bin/falda   # remove the symlink, if linked
rm -rf node_modules dist                             # remove build artifacts
```
