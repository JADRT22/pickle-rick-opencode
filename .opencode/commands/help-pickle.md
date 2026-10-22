---
description: 🥒 Show Pickle Rick help
---
Print this help verbatim, as a short cheat sheet, in the user's language:

**Pickle Rick for opencode** 🥒
- `/pickle "<task>" [--max-iterations N] [--max-time MIN] [--max-tokens N|off] [--worker-timeout SEC] [--name SLUG] [--completion-promise TEXT] [--resume [PATH]]` — start the loop (defaults: 5 iterations, 60 min, 2M tokens, 20 min per Morty, promise `DONE`)
- `--max-tokens` caps the task (parent + Morty children); when it is hit the loop stops with `max-tokens`. `off` disables the cap.
- `/pickle-prd "<idea>"` — interactive PRD first, then `/pickle --resume`
- `/eat-pickle` — cancel the loop
- `/add-to-pickle-jar "<task>"` — queue a task · `/pickle-jar-open` — run the queue
- State and artifacts live in `.pickle-rick/sessions/<session>/` (prd.md, tickets/, research/, plans/)
- Press Esc to interrupt: the loop stops instead of re-prompting.
