# Claude Code plugin — design

**Status: proposed / future work. Not yet implemented.** Nothing here has
landed in `integrations/`. This document specifies a Claude Code plugin
that provides the same four memory behaviours the opencode plugin
(`integrations/opencode/plugin/falda-capture.ts`) already provides, plus
two Claude Code-native surfaces (a Skill and slash commands) that opencode
has no equivalent for.

It is written to be read alongside the opencode plugin, and it records
*why* the port diverges where it does — the divergences are forced by
runtime differences, not preference.

## Background: what the opencode plugin does

Four independent features over one shared credential path:

1. **Auto-capture** — writes each user/assistant turn to Stream (T0) as it
   happens, so distillation has raw material without the model having to
   remember to call a tool.
2. **Auto-recall** — one `falda_recall` (`mode: "auto"`) on the first user
   message of a session, injected into that message wrapped in
   `<falda-auto-recall>`.
3. **Auto-distill** — one `falda_distill` on `experimental.session.compacting`,
   used purely as a timing trigger so the job runs concurrently with
   compaction's summary generation.
4. **Post-compaction recall** — a second auto-recall on the first real user
   message after a compaction, since the summary may have dropped detail
   that T0 still holds.

Four disciplines from that plugin are load-bearing and are preserved here:

- **One credential resolution, shared by every feature**, derived from the
  same config the MCP tools use — so capture can never write to a different
  tenant than recall reads from.
- **Every feature independently switchable** by env var, defaults on.
- **Nothing ever blocks or fails a turn.** Timeouts, log-and-swallow.
- **The background worker is the safety net.** Hook-driven distillation is
  a latency optimisation on top of the periodic sweep, never a dependency.

## Runtime differences that force divergence

| | opencode | Claude Code |
|---|---|---|
| Plugin model | in-process TS module, long-lived closure | hooks are **separate processes**, one per event |
| State | in-memory `Map`/`Set` | must be on disk |
| Message text | streamed `Part` objects, reassembled by `messageID` | delivered whole: `prompt`, `last_assistant_message` |
| Recall injection | mutate `output.parts` on `chat.message` | `hookSpecificOutput.additionalContext` |
| Compaction trigger | `experimental.session.compacting` | `PreCompact` / `PostCompact` (**both stable**) |
| Credential source | `client.config.get()` → `mcp.falda.headers` | `${FALDA_*}` env, shared with `.mcp.json` |
| MCP client | `@modelcontextprotocol/sdk` | stateless JSON-RPC over `fetch`, no dependency |
| Backgrounding | manual timeout races | `"async": true` per hook |

Two of these make the Claude Code port *simpler* than the original, and one
makes it stricter:

- Message text arrives whole, so the entire part-reassembly machinery
  (`pending`, `settledRole`, `flushedIds`, rollback-on-failure) has no
  counterpart here and is deleted.
- `"async": true` makes capture and distill genuinely non-blocking, rather
  than blocking-with-a-timeout.
- `UserPromptSubmit` exit code 2 *"blocks prompt processing and erases the
  prompt."* A crashing hook would destroy the user's typed input, so the
  never-exit-nonzero rule is load-bearing rather than hygienic.

### Why recall does not fire on `SessionStart`

The obvious mapping — "session begins, so recall" — is wrong.
`SessionStart` fires before the user has typed anything, so there is no
query to recall against, and `falda_recall` requires `query` or `topic`.
Firing there could only ever return a fixed topic or a core dump, which
discards the semantic retrieval that is the point of FALDA.

opencode fires on `chat.message`, which *has* the user's text. The faithful
equivalent is `UserPromptSubmit`, gated to the first prompt of a session.
The same reasoning applies to post-compaction recall: opencode waits for
"the next real user message" after `session.compacted`, so here `PostCompact`
only sets a flag and the next `UserPromptSubmit` performs the recall.

## Design

### Layout

Lives at `integrations/claude-code/`, mirroring `integrations/opencode/`.

```
integrations/claude-code/
  .claude-plugin/plugin.json      manifest
  .mcp.json                       falda MCP server, ${FALDA_*} interpolation
  hooks/
    hooks.json                    event registration
    falda-hook.mjs                single dispatcher: falda-hook.mjs <subcommand>
    lib/
      creds.mjs                   env resolution + enabled-feature gating
      mcp.mjs                     stateless JSON-RPC client: timeout, never throws
      state.mjs                   per-session JSON state, atomic write
      log.mjs                     rotating file log (never stdout)
  skills/falda-memory/SKILL.md    ported from AGENTS.md.snippet
  commands/
    recall.md  remember.md  status.md  distill.md
  README.md
```

One dispatcher rather than five scripts: credential resolution, the timeout
policy, and the always-exit-0 rule then live in exactly one place, following
the pattern the superpowers plugin uses (`hooks/run-hook.cmd <event>`).

A repo-root `.claude-plugin/marketplace.json` makes it installable via
`/plugin marketplace add` → `/plugin install falda-memory`.

### Event map

| Hook | Config | Subcommand | Behaviour |
|---|---|---|---|
| `UserPromptSubmit` | `async: true` | `capture-user` | `falda_stream_add` with the `prompt` |
| `UserPromptSubmit` | `timeout: 10` | `auto-recall` | if first-of-session **or** post-compact pending → `falda_recall` (`mode: "auto"`), inject |
| `Stop` | `async: true` | `capture-assistant` | `falda_stream_add` with `last_assistant_message` |
| `PreCompact` | `async: true` | `distill` | `falda_distill {}`, fire-and-forget |
| `PostCompact` | `async: true` | `mark-compacted` | set `postCompactPending` |

These are the same four tools the opencode plugin calls
(`falda-capture.ts`), so both integrations exercise one surface.

`UserPromptSubmit` registers **two** hooks. Capture is a write that must not
delay the prompt, so it is async; recall must be synchronous because its
output has to reach the model with the prompt. They are independent — recall
queries long-term memory, not the current turn — so ordering does not matter.

Input fields used: `session_id` and `prompt_id` (common, `prompt_id`
optional — see "Capture and idempotency" below); `prompt`
(`UserPromptSubmit`); `last_assistant_message` (`Stop`). Nothing reads
`transcript_path` — that is what the `last_assistant_message` decision
below buys. `PreCompact` fires distill regardless of `trigger`, and
`PostCompact` needs no fields beyond `session_id`.

**The published Claude Code hook reference is wrong about the
`UserPromptSubmit` field name and about the `PreCompact` field name.** It
documents `user_prompt`; the field the binary actually emits is `prompt`
(verified directly against a shipped `claude` binary — `strings -a
~/.local/share/claude/versions/<version> | grep -o
'hook_event_name:"UserPromptSubmit".\{0,120\}'` yields
`hook_event_name:"UserPromptSubmit",prompt:r,...`; the string
`user_prompt` appears in that binary only as an OpenTelemetry span
attribute, never in a hook payload). It documents `compaction_reason` for
`PreCompact`; the real field is `trigger`. This was the source of a
critical bug in an earlier version of this plugin (`capture-user` and
`auto-recall` both read the non-existent `input.user_prompt`, so user
prompts were silently never captured and recall was silently dead). The
code now reads `input.prompt ?? input.user_prompt` defensively, but do
**not** "fix" this document, the code, or the tests back to treating
`user_prompt` as primary — `prompt` is the real field.

Injection shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<falda-auto-recall>\n...\n</falda-auto-recall>"
  }
}
```

The wrapper text matches the opencode plugin's verbatim, so the guidance in
`AGENTS.md.snippet` (and the ported Skill) describes both integrations
without modification.

### Credential resolution

`.mcp.json` and the hooks read the **same** environment variables:

```json
{ "mcpServers": { "falda": {
    "type": "http",
    "url": "${FALDA_MCP_URL:-http://localhost:8079/mcp}",
    "headers": {
      "Authorization": "Bearer ${FALDA_TOKEN}",
      "X-Falda-Tenant": "${FALDA_TENANT}"
    } } } }
```

This preserves opencode's core discipline — capture and recall cannot
address different tenants — by construction rather than by a lookup.
Per-project tenants come from the shell, `.envrc`, or a `settings.json`
`env` block, exactly as `FALDA_TOKEN` already works for the `falda show
recall` and `falda stats --section=timing` CLI clients (`README.md`,
"CLI-client environment variables").

Because the hooks speak MCP too, **the model and the hooks share one
endpoint, one port, and one credential** — the same three values, not merely
consistent ones. Nothing beyond `:8079` needs to be reachable, so the
existing "expose only the MCP port to agent containers" deployment
(`integrations/opencode/README.md` §2b) works unchanged.

Missing `FALDA_TOKEN` or `FALDA_TENANT` is a **silent no-op**, so the plugin
can be installed globally and simply do nothing in projects that have no
FALDA tenant.

### Speaking MCP without the SDK

The opencode plugin depends on `@modelcontextprotocol/sdk`
(`StreamableHTTPClientTransport`). The hooks here do not need it: FALDA's
MCP endpoint accepts **stateless single-shot JSON-RPC POSTs**, verified
against a running server — `falda_whoami`, `falda_stream_add`,
`falda_recall`, and `falda_distill` all returned `200` with no `initialize`
handshake and no `Mcp-Session-Id` header.

So `lib/mcp.mjs` is a `fetch` POST to `${FALDA_MCP_URL}` carrying
`{jsonrpc, id, method: "tools/call", params: {name, arguments}}`, plus the
one wrinkle: responses come back framed as `text/event-stream`, so the
client takes the `data: ` line and parses it. Tool results arrive as JSON
encoded in `result.content[0].text`, needing a second `JSON.parse`.

This keeps the plugin dependency-free — no `node_modules`, no install step,
nothing to version-track (contrast `integrations/opencode/README.md` §4b,
"Dependency version tracking and persistent-volume caveats"). The
assumption it rests on is recorded under "Open questions".

### Capture and idempotency

Each captured turn is sent via `falda_stream_add` with a `turn_id` and
**no** `turn_index`:

- user turn: `turn_id = "cc-<prompt_id>-user"`
- assistant turn: `turn_id = "cc-<prompt_id>-assistant"`

`src/falda.ts` indexes `UNIQUE(session_id, turn_id) WHERE turn_id IS NOT
NULL`, and invariant 2 (`src/falda.ts:546`) treats a repeat as a no-op when
the stored `turn_index` equals the supplied one. With `turn_index` omitted
on both sides that comparison is `null === null`, so **a replayed turn is a
no-op returning the existing id.**

This is why no watermark, no sequence counter, and no dedupe set are needed:
the server is the idempotency authority, so two concurrently-running async
hooks cannot corrupt anything, and a retry is always safe. A `409` is logged
and dropped, never retried.

`prompt_id` is **optional** in the real payload (the shipped binary builds
it as `Qst() ?? void 0`, i.e. it can be absent). When it is missing, the
hooks omit `turn_id` entirely rather than send a fixed literal like
`"cc-undefined-user"` for the whole session — the invariant-2 check above
(`src/falda.ts:546-552`) matches on `turn_id` **without comparing content**,
so a colliding constant `turn_id` would make every second-and-later turn in
that session look like a replay of the first and be silently discarded.
Omitting `turn_id` instead means duplicates are possible (no dedup key),
which is far cheaper than silent data loss.

Only user prose and assistant prose are captured. Tool calls and tool
results are not — matching opencode, which filters to `part.type === "text"`
(`falda-capture.ts:309`) and drops system messages (`:320`). Distillation
runs an LLM over T0 to extract typed atoms; bash output and diffs are noise
it would have to reject, while still costing embedding work per turn.

**Known fidelity gap.** `last_assistant_message` is the *final* response of
a turn, so intermediate assistant prose between tool calls is not captured,
where opencode captured every text part. Accepted deliberately: in an
agentic turn that intermediate text is mostly procedural narration, and the
final response carries the substantive conclusion. Parsing
`transcript_path` would close the gap at the cost of a JSONL parser, a
watermark, and `isSidechain`/tool-block filtering. See "Open questions".

### State

Hooks are separate processes, so opencode's in-memory sets become one file
per session at `~/.falda/claude-code/<session_id>.json`:

```json
{ "recalled": true, "postCompactPending": false }
```

Two booleans, mirroring `autoRecalled` and `pendingPostCompactRecall`.
Written atomically (temp file + `rename`). Files older than 7 days are
pruned opportunistically on write. Deliberately **not** under
`${CLAUDE_PLUGIN_ROOT}`, which is a read-only cache path.

One-shot semantics carry over unchanged: both flags are consumed *before*
the recall is attempted, so a failure never causes a retry on a later
prompt, and if both reasons somehow coincide on one prompt exactly one
recall fires.

### Failure policy

Every hook exits 0. Always.

- 5s `AbortSignal.timeout` per request, matching opencode's
  `AUTO_RECALL_TIMEOUT_MS`/`DISTILL_TIMEOUT_MS`.
- Any failure — server down, 401, malformed JSON, missing env, timeout —
  means no injection and no capture, never a broken turn.
- Diagnostics go to `~/.falda/claude-code/hook.log` (rotating), **never to
  stdout**: on `UserPromptSubmit`, stdout *is* the injection channel, so a
  stray `console.log` would be injected into the model's context.
- Distillation degrades to the background sweep worker
  (`FALDA_SWEEP_INTERVAL_MS`), exactly as in opencode.

### Skill and commands

`skills/falda-memory/SKILL.md` ports `integrations/opencode/AGENTS.md.snippet`:
recall before non-trivial work; `falda_remember` for durable facts only;
content is immutable, so a correction is a new atom rather than an edit;
`falda_forget` stops recall and is not privacy erasure; `<falda-auto-recall>`
is a small-budget starting point, not a substitute for a real recall;
`falda_whoami` to diagnose surprising results.

Commands, which have no opencode equivalent:

| Command | Does |
|---|---|
| `/falda-memory:recall <query>` | deliberate full-budget recall (not `mode: "auto"`) |
| `/falda-memory:remember <content>` | store an atom, prompting for `type` if ambiguous |
| `/falda-memory:status` | `falda_whoami` + `GET :8079/healthz` (unauthenticated) |
| `/falda-memory:distill` | force an out-of-cycle distillation pass |

Slash commands and skills are namespaced by **plugin** name
(`.claude-plugin/plugin.json`'s `name`, here `falda-memory`), never by
marketplace name (here `falda`, from the repo-root
`.claude-plugin/marketplace.json`). Verified the same way as the
`UserPromptSubmit` field name above: by inspecting how an installed
plugin's own commands/skills resolve at runtime (e.g. an installed
`superpowers` plugin, whose marketplace is `claude-plugins-official`,
exposes `superpowers:brainstorming` — namespaced by the plugin name, not
the marketplace name). Do not "fix" the invocation back to `/falda:...`
to match the plugin's own display name; that string does not resolve.

## Configuration

Feature flags keep opencode's names, semantics, and defaults-on behaviour:

| Env var | Default | Notes |
|---|---|---|
| `FALDA_MCP_URL` | `http://localhost:8079/mcp` | MCP endpoint, used by **both** the model and the hooks |
| `FALDA_TOKEN` | *(unset)* | bearer token; unset ⇒ plugin is a no-op |
| `FALDA_TENANT` | *(unset)* | tenant; unset ⇒ plugin is a no-op |
| `FALDA_CAPTURE` | on | `0` disables capture |
| `FALDA_AUTO_RECALL` | on | `0` disables first-prompt recall |
| `FALDA_DISTILL_ON_COMPACT` | on | `0` disables `PreCompact` distill |
| `FALDA_RECALL_ON_COMPACT` | on | `0` disables post-compaction recall; **forced off when `FALDA_CAPTURE=0`** |

The forced-off rule is inherited verbatim: post-compaction recall exists to
re-surface detail the summary dropped, and that only works if capture has
been writing this session's turns to T0.

## Testing

`test/claude_code_plugin.test.ts`, run by the existing
`tsx --test test/*.test.ts`. Following `test/stats_timing.test.ts`, which
already spins a real server on port 0 with a temp root and token file:

- **Injection shape** — valid `hookSpecificOutput` JSON, `<falda-auto-recall>`
  wrapper, `hookEventName: "UserPromptSubmit"`.
- **One-shot semantics** — recall fires once per session; post-compact fires
  once per compaction; both-pending on one prompt fires exactly one recall;
  a failed recall does not retry on the next prompt.
- **Idempotent replay** — the same turn sent twice yields one T0 row.
- **Stateless MCP** — a bare `tools/call` with no `initialize` and no
  `Mcp-Session-Id` succeeds, and an SSE-framed (`text/event-stream`)
  response is unwrapped correctly, including the inner
  `result.content[0].text` JSON. This is the assumption the dependency-free
  client rests on, so it is asserted rather than trusted.
- **Capture content** — user and assistant prose stored; no tool text.
- **Failure policy** — server down, bad token, missing env, and malformed
  hook input each exit 0 with empty stdout.
- **Never exit 2** — explicitly asserted for `UserPromptSubmit`, since a
  non-zero exit there erases the user's prompt.
- **State** — atomic write survives a concurrent writer; prune drops files
  older than 7 days and keeps fresh ones.

## Work items

1. Plugin scaffold: `plugin.json`, `.mcp.json`, `marketplace.json`.
2. `hooks/lib/`: `creds`, `client`, `state`, `log`.
3. `falda-hook.mjs` dispatcher + `hooks.json` registration.
4. The five subcommands.
5. `skills/falda-memory/SKILL.md`.
6. The four slash commands.
7. `test/claude_code_plugin.test.ts`.
8. **Documentation** — `integrations/claude-code/README.md` (setup, env,
   feature flags, troubleshooting); a "Claude Code"
   section in `docs/HARNESS_INTEGRATION.md` alongside the existing Hermes /
   OpenClaw / opencode sections; a pointer from `README.md` next to the
   existing opencode pointer; and a mention in `docs/MCP.md` where it
   currently references only the opencode integration.

## Non-goals

- **Recall usage feedback.** `docs/MCP.md` states plainly that usage
  feedback "is deliberately not an MCP tool" — it is an HTTP-only harness
  responsibility (`POST /recall/usage`, `docs/RECALL_TRACES.md`). Adopting
  it would reintroduce the second port this design just removed, and which
  injected items the model actually used is not reliably observable from a
  hook anyway. Deliberately deferred rather than guessed at.
- **Pool administration.** Not exposed over MCP in either toolset; stays an
  HTTP-API admin concern.
- **Bundling a FALDA server.** The plugin assumes a reachable `falda serve`.
- **Capturing subagent (`isSidechain`) turns.** Out of scope while capture
  is sourced from `last_assistant_message`.

## Open questions

- Should the transcript-parsing capture path be built later to close the
  intermediate-prose gap, or is the final response the better distillation
  input on purpose? Worth revisiting once there is real T1 output to judge
  the quality of.
- Should `/falda-memory:status` shell out to `falda stats` (offline, richer) rather
  than the MCP/HTTP surfaces? That would couple the plugin to a local
  checkout, which the rest of the design avoids.
- The dependency-free MCP client assumes FALDA's endpoint keeps accepting
  **stateless** single-shot `tools/call` POSTs. That holds today (verified
  against a running server) and is a valid Streamable HTTP mode, but it is
  not a contract `docs/MCP.md` currently states. If the server ever requires
  an `initialize` handshake or a `Mcp-Session-Id`, `lib/mcp.mjs` grows a
  handshake or the plugin adopts `@modelcontextprotocol/sdk` and a
  `node_modules`. Worth writing down in `docs/MCP.md` as a supported mode if
  this design is built, so the plugin is not depending on an accident.
