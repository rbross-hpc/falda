---
description: Force an out-of-cycle FALDA distillation pass
---

Call the `falda_distill` MCP tool with no arguments to enqueue a
distillation pass for this project's store, then report the returned
`job_id` and `store_key`.

Distillation is asynchronous. If the user wants confirmation it finished,
poll `falda_distill_status` with that `job_id` — it returns `pending`,
`running`, `done`, or `failed`/`dead`.

Note for the user: this is normally unnecessary. A hook enqueues a pass when
the session compacts, and a background worker sweeps periodically. This is
for requesting an immediate run.
