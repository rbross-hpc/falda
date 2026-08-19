---
description: Show which FALDA tenant this project addresses, and whether the server is reachable
---

Report the state of this project's FALDA connection:

1. Call the `falda_whoami` MCP tool and report the resolved tenant.
2. Fetch `/healthz` on the FALDA server (the host and port of
   `FALDA_MCP_URL`, path `/healthz` — it is unauthenticated) and report
   whether the endpoint is up.
3. Report the values of `FALDA_MCP_URL` and `FALDA_TENANT` from the
   environment. **Never print `FALDA_TOKEN`.** Read and echo only these two
   variables individually (e.g. one command per variable, or a command that
   names exactly these two). **Never run `env`, `printenv`, or any other
   unfiltered environment dump** — even piped through `grep FALDA`, that
   family of command still prints `FALDA_TOKEN` to the transcript. Once a
   secret is in the transcript, the capture hook writes it to T0 like any
   other assistant/user text, and a later distillation pass could promote it
   into a durable memory — this is the one command whose output must stay
   scoped to exactly the two named, non-secret variables.

If `falda_whoami` fails, the most common causes are a server that is not
running, or `FALDA_TOKEN`/`FALDA_TENANT` unset — in which case the capture
and recall hooks are silently doing nothing. Say which of those it looks
like.
