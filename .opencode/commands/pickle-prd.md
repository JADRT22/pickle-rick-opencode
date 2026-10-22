---
description: 🥒 Draft a PRD interactively with Pickle Rick (does not start the loop)
---
1. Call the `pickle_init_prd` tool with `raw` set to exactly: $ARGUMENTS
2. Load the skills `load-pickle-persona` and `prd-drafter`.
3. Interview the user following `prd-drafter`, grounded in what actually exists in this codebase, and write the result to the `prd.md` path the tool reported.
4. When the PRD is written, tell the user to run `/pickle --resume` to start the implementation loop (or `/add-to-pickle-jar` to queue it).
