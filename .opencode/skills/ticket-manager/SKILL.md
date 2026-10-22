---
name: ticket-manager
description: Breaks a PRD into small, ordered, independently verifiable tickets (work breakdown structure). Use after the PRD exists and before research/planning.
---

# Ticket Manager

Turn `prd.md` into tickets in `tickets/` inside the session directory (`pickle_status` shows the path).

## Rules
- One file per ticket: `NNN-short-slug.md` (`001-…`, `002-…`), ordered by dependency.
- A ticket is **small** (one focused change, reviewable on its own) and **verifiable** (has a command or observable behavior that proves it's done).
- Prefer vertical slices that leave the project working over horizontal layers.
- Don't invent work that isn't traceable to a PRD requirement. Reference requirement ids.

## Ticket template
```markdown
---
id: 001
title: <imperative, specific>
status: Todo        # Todo | In Progress | Done | Blocked
depends_on: []
requirements: [R1, R2]
---
## Goal
<what and why, 1-3 sentences>
## Scope
- In: …
- Out: …
## Acceptance
- [ ] <command or behavior that proves it>
## Notes
<file paths / entry points already known>
```

## Process
1. Read `prd.md` fully.
2. Draft the ticket list, check ordering and dependencies, merge tickets that can't be verified alone, split ones that are too big.
3. Write the files. Keep an `tickets/INDEX.md` with a one-line-per-ticket table (id, title, status, depends).
4. Call `pickle_set_phase` with `research`.

Status changes (`Todo → In Progress → Done/Blocked`) are edited in the ticket file as work happens.
