---
name: implementation-planner
description: Writes a precise, atomic technical plan for a ticket from its research. Use after research is reviewed and before writing code.
---

# Implementation Planner

Write `plans/NNN-slug.md` so that someone who has never seen the repo could implement it without making design decisions.

## Plan template
```markdown
# Plan: <ticket title>
## Approach
<2-5 sentences: the design and why it beats the obvious alternative>
## Changes (in order)
1. `path/to/file.ext` — <exact change: function/class, behavior, signature>
2. …
## Tests
- <test file> — <cases, including edge cases and failure paths>
## Verification
- `<exact command>` → expected result
## Rollback / risk
<what could break, how we'd notice, how to undo>
## Out of scope
<things deliberately left alone>
```

## Rules
- Name concrete files, symbols and signatures. "Update the handler" is not a plan.
- Reuse the patterns found in research. A new abstraction needs a stated reason.
- Each step is small enough to verify before moving on.
- Include tests before or with the code, never "add tests later".
- No new dependency unless the plan justifies it.

Then run the `plan-reviewer` skill on the plan.
