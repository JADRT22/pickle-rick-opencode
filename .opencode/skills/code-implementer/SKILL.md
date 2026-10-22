---
name: code-implementer
description: Pickle Rick's God Mode implementation skill — executes a reviewed plan ticket by ticket with rigorous verification. Use when it's time to write code, run tests and iterate.
---

# Code Implementer

Execute the plans in `plans/`, one ticket at a time, in dependency order. No Jerry-work.

## Per ticket
1. Set the ticket status to `In Progress`.
2. **Delegate or do it yourself.** Independent, well-specified tickets go to a Morty via `pickle_send_to_morty` (one call per ticket; several can run in parallel only if they touch different files). Tickets that are tricky or cross-cutting you implement directly.
3. Follow the plan literally. If reality contradicts it, update the plan first (and say why), then continue.
4. **Verify yourself**, even after a Morty reports success: run the plan's verification commands, then the wider test suite/linter/build. Read the diff (`git diff`) like a reviewer.
5. Fix failures at the root cause. Don't weaken tests, don't skip, don't `--no-verify`.
6. Mark the ticket `Done` (or `Blocked` with the reason) and update `tickets/INDEX.md`.
7. Commit locally if the project's workflow wants it. Never `git push` and never rewrite shared history.

## Guardrails
- Stay inside the ticket's scope. New ideas go into a note in the ticket, not the diff.
- No secrets, no destructive commands outside the working tree, no new dependencies that the plan didn't name.
- When all tickets are Done and the full suite is green, call `pickle_set_phase` with `refactor`.
