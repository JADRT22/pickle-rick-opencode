---
description: 🥒 Show Pickle Rick help
---
Print this help verbatim, as a short cheat sheet, in the user's language:

**Pickle Rick for opencode** 🥒
- `/pickle "<task>" [--max-iterations N] [--max-time MIN] [--max-tokens N|off] [--worker-timeout SEC] [--morty-model PROVIDER/MODEL] [--name SLUG] [--completion-promise TEXT] [--allow-dirty] [--force] [--resume [PATH]]` — start the loop (defaults: 5 iterations, 60 min, 2M tokens, 20 min per Morty, promise `DONE`)
- `--max-tokens` caps the task (parent + Morty children); when it is hit the loop stops with `max-tokens`. `off` disables the cap, and a warning fires at 80%.
- `--morty-model` runs workers on a cheaper/other model (default: inherit the parent's model). `--force` replaces an active loop; `--allow-dirty` skips the clean-tree check.
- `/pickle-prd "<idea>"` — interactive PRD first, then `/pickle --resume`
- `/eat-pickle` — cancel the loop
- `/add-to-pickle-jar "<task>"` — queue a task · `/pickle-jar-list` — inspect the queue · `/pickle-jar-open` — run it
- State and artifacts live in `.pickle-rick/sessions/<session>/` (prd.md, tickets/, research/, plans/). Tickets with `Status: done` are skipped automatically.
- Press Esc to interrupt: the loop stops instead of re-prompting.
