---
description: Save a durable memory to FALDA
---

Save this to long-term memory: $ARGUMENTS

Call the `falda_remember` MCP tool with `{ content, type }`.

Choose `type` from `fact`, `pattern`, `preference`, `constraint`,
`instruction`. If the right type is genuinely ambiguous, ask the user which
one rather than guessing — the type drives how the memory is later ranked
and surfaced.

Content is immutable once written. If the user is correcting something
previously remembered, save the corrected statement as a new memory and tell
them the old one still exists until it is forgotten with `falda_forget`.

`falda_remember` returns `{id, type, pinned}` — there is no `atom_id` field
in its output. Report the returned `id` precisely: that value is what
`falda_forget`'s `atom_id` input parameter expects, so tell the user to
quote it back verbatim if they later want to forget this memory.
