---
description: Search FALDA long-term memory with a deliberate, full-budget recall
---

Call the `falda_recall` MCP tool with:

- `query`: $ARGUMENTS
- omit `mode`, so this uses the full explicit budget (`FALDA_RECALL_BUDGET`)
  rather than the smaller automatic one

Then summarise what came back for the user: the assembled context, and how
many items were admitted from each tier. If `truncated` is true, say so and
mention that a narrower query would fit more detail per item.

If nothing is returned, say so plainly rather than speculating about what
might be in memory.
