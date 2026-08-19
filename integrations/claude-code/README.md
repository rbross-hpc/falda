# FALDA memory for Claude Code

A Claude Code plugin that gives sessions the same automatic memory behaviour
the [opencode integration](../opencode/README.md) provides —
`integrations/opencode/plugin/falda-capture.ts` — reimplemented for Claude
Code's process-per-hook model, plus two Claude Code-native surfaces
(a Skill and slash commands) that opencode has no equivalent for. See
[`docs/future/claude-code-plugin.md`](../../docs/future/claude-code-plugin.md)
for the full design rationale, including why the port diverges from opencode
where it does.

## What it does

Four independent, hook-driven features, all reading one shared credential:

| Feature | Fires on | Behaviour |
|---|---|---|
| **Auto-capture** | every user prompt and every assistant response | writes the turn to FALDA's Stream (T0) as it happens, so distillation has raw material without the model having to call a tool |
| **Auto-recall** | the first user prompt of a session | runs one small `falda_recall` (`mode: "auto"`) and injects the result into that prompt, wrapped in `<falda-auto-recall>` |
| **Auto-distill** | the session compacting (`PreCompact`) | fires one `falda_distill` as a fire-and-forget timing trigger, so the distillation job runs concurrently with compaction's summary generation |
| **Post-compaction recall** | the first user prompt after a compaction | runs a second `<falda-auto-recall>` recall, since the compaction summary may have dropped detail that T0 still holds |

These mirror the four features of
`integrations/opencode/plugin/falda-capture.ts` — both integrations call the
same four `falda_*` tools, so they exercise one MCP surface. The plugin never
blocks or fails a turn: every hook logs and swallows on any error and always
exits `0`.

## Install

From within a Claude Code session, once for this checkout of FALDA:

```
/plugin marketplace add /path/to/falda
/plugin install falda-memory
```

`/path/to/falda` is a local checkout of this repository (it contains the
repo-root `.claude-plugin/marketplace.json` that lists `falda-memory`,
sourced from `integrations/claude-code/`). Installing the plugin registers
its hooks (`hooks/hooks.json`), its MCP server (`.mcp.json`), its Skill
(`skills/falda-memory/SKILL.md`), and its four slash commands
(`/falda-memory:recall`, `/falda-memory:remember`, `/falda-memory:status`, `/falda-memory:distill`).

## Configure

Three environment variables, the same three names used everywhere else in
this repo (`README.md`, "CLI-client environment variables";
`integrations/opencode/README.md`):

| Var | Meaning | Default |
|---|---|---|
| `FALDA_MCP_URL` | the FALDA MCP endpoint | `http://localhost:8079/mcp` |
| `FALDA_TOKEN` | bearer token for that endpoint | *(unset — plugin is a no-op)* |
| `FALDA_TENANT` | which tenant this project addresses | *(unset — plugin is a no-op)* |

Set them per project however you'd set any other project-scoped env var —
your shell profile, a project `.envrc` (if you use direnv), or a
`settings.json` `env` block:

```json
{
  "env": {
    "FALDA_MCP_URL": "http://falda-host:8079/mcp",
    "FALDA_TOKEN": "your-bearer-token",
    "FALDA_TENANT": "your-project-tenant"
  }
}
```

> **Put that block in the project's settings, not `~/.claude/settings.json`.**
> Claude Code merges user-level settings into every project on the machine, so
> a `FALDA_TENANT` set there quietly becomes the tenant for all of them: every
> repo you open captures into one pool, and `falda_recall` in one project
> returns another project's memories. Per-tenant isolation is the entire point
> of the pool layer, and this defeats it in a single line.
>
> It is also close to invisible once done. `/falda-memory:status` reports the
> tenant it resolved, but a wrong-because-shared tenant looks exactly like a
> right one — the symptom shows up much later as unrelated memories surfacing
> in recall. If that happens, check the *user-level* settings file first.
>
> The right homes are `.claude/settings.json` inside the project (committed —
> `FALDA_MCP_URL` and `FALDA_TENANT`, no secrets) and
> `.claude/settings.local.json` (kept out of git — `FALDA_TOKEN`).

**This is the one design point worth understanding before anything else:**
`.mcp.json` (the model's MCP tool connection) and every hook read the exact
same three variables — not merely "consistent" values, the same lookup.
`.mcp.json` interpolates `${FALDA_MCP_URL}`, `${FALDA_TOKEN}`, and
`${FALDA_TENANT}` directly into the `falda` MCP server config, and
`hooks/lib/creds.mjs` resolves those same three names from `process.env`.
There is no second place to configure a tenant and no way for capture to
write to a different tenant than the one the model's `falda_recall` reads
from — auto-capture and the model's own tool calls are addressing the same
tenant by construction, not by convention.

If a project has no FALDA tenant, simply don't set `FALDA_TOKEN`/
`FALDA_TENANT` there — see "Troubleshooting" below for what that looks like
in practice.

## Feature flags

All four features default on. Each is switched off independently by setting
its variable to the exact string `"0"` — any other value (including `""` or
`"false"`) leaves it on:

| Env var | Default | `0` disables |
|---|---|---|
| `FALDA_CAPTURE` | on | writing user/assistant turns to T0 |
| `FALDA_AUTO_RECALL` | on | the first-prompt-of-session recall injection |
| `FALDA_DISTILL_ON_COMPACT` | on | the `PreCompact` distill trigger |
| `FALDA_RECALL_ON_COMPACT` | on | the post-compaction recall injection |

`FALDA_RECALL_ON_COMPACT` is additionally **forced off whenever
`FALDA_CAPTURE=0`**, regardless of its own value. Post-compaction recall
exists to re-surface detail the compaction summary dropped — but that detail
only exists in T0 if auto-capture has been writing this session's turns
there. With capture off, there is nothing extra for it to find.

## What gets captured

Only user prose and assistant prose — no tool calls, no tool results, no
system messages. This matches the opencode plugin, which filters to text
parts and drops everything else. Distillation runs an LLM over T0 to extract
durable atoms; bash output and diffs are noise it would have to filter back
out, while still costing embedding work per captured turn.

**Known fidelity limitation.** Assistant-side capture uses the `Stop` hook's
`last_assistant_message` field, which is the turn's *final* response. In an
agentic turn that makes several tool calls with narration in between, only
that final response is captured — intermediate assistant prose between tool
calls is not, where the opencode plugin (which sees a live stream of message
parts) captures all of it. This is a deliberate tradeoff, not an oversight:
in most agentic turns the intermediate text is procedural narration, and the
final response carries the substantive conclusion. See "Open questions" in
`docs/future/claude-code-plugin.md` if you're evaluating whether this
matters for your use.

## Hook timeout ordering

`hooks/hooks.json` sets an external harness `"timeout": 10` (seconds) on the
`auto-recall` hook, deliberately larger than `falda-hook.mjs`'s own internal
`TIMEOUT_MS = 5000` (5 seconds) fetch budget. This ordering is required, not
arbitrary: Node process boot plus reading stdin adds latency on top of the
internal fetch timeout, so if the harness timeout were less than or equal to
the internal one, a slow server could cause the *harness* to kill the process
by signal before it reaches its own `AbortSignal.timeout`-driven error path —
which would bypass the always-exit-0 guarantee this plugin depends on. Keep
the harness timeout comfortably above the internal one if either is changed.
JSON does not support inline comments, hence this note living here rather
than in `hooks.json` itself.

## Troubleshooting

- **Log file**: `~/.falda/claude-code/hook.log` (or, if `FALDA_CC_STATE_DIR`
  is set, `<that dir>/hook.log`). One JSON line per event, rotated at 1 MiB.
  Every hook failure — connection refused, non-2xx response, malformed
  input, timeout — is logged here rather than to stdout or stderr, because
  on `UserPromptSubmit` stdout *is* the channel the recall injection uses;
  a stray print there would land in the model's context instead of a log.
- **`/falda-memory:status`**: run this slash command to check what the plugin
  currently resolves — it calls `falda_whoami` and reports the tenant it
  got back, fetches the FALDA server's unauthenticated `/healthz`, and
  prints `FALDA_MCP_URL`/`FALDA_TENANT` from the environment (never
  `FALDA_TOKEN`). This is the fastest way to tell "server unreachable" from
  "not configured" from "wrong tenant".
- **"Nothing is happening" is expected when `FALDA_TOKEN` or `FALDA_TENANT`
  is unset.** Every hook treats missing credentials as a **silent no-op** —
  by design, so the plugin can be installed globally and simply do nothing
  in projects that don't have a FALDA tenant configured. If capture and
  recall both appear inert, check `/falda-memory:status` or the environment before
  assuming something is broken.
- **`FALDA_CC_STATE_DIR`**: overrides the plugin's state directory (default
  `~/.falda/claude-code/`), which holds per-session recall-tracking state
  (`<session_id>.json`) and `hook.log`. This exists as a testing seam — set
  it to point the hooks at an isolated temp directory when scripting or
  testing the plugin rather than exercising a real `~/.falda/`.
  It is also the remedy on a **read-only `$HOME`**: `writeState` fails
  silently there (state is an optimisation, never a correctness
  requirement — see `hook.log`, which best-effort-logs the failure), but
  the practical effect is that `recalled` never persists, so *every*
  prompt re-attempts the synchronous 5s auto-recall instead of firing
  once per session. Point `FALDA_CC_STATE_DIR` at a writable directory to
  fix that.

## Requirements

- **Node >= 20** — the hooks are dependency-free `.mjs` scripts run directly
  by `node`; there is no `package.json` under `integrations/claude-code/`
  and no `node_modules` to install.
- **A reachable `falda serve` MCP endpoint** — by default
  `http://localhost:8079/mcp`. Only the MCP port (`8079`) needs to be
  reachable from wherever Claude Code runs. The hooks speak MCP directly via
  a small dependency-free JSON-RPC client (`hooks/lib/mcp.mjs`); they never
  call FALDA's HTTP/JSON API (port `8077`), so you do not need to expose or
  configure that port for this plugin to work.
