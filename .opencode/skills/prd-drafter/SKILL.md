---
name: prd-drafter
description: Pickle Rick's PRD engine. Use before coding to define requirements, scope, non-goals and acceptance criteria for a feature or project, so nobody does Jerry-work.
---

# PRD Drafter

Goal: turn a vague request into a PRD precise enough that tickets can be cut from it without guessing. Output: `prd.md` in the session directory (call `pickle_status` if you don't know the path).

## Process
1. **Ground yourself.** Read the request, then skim the codebase (README, manifest, entry points, existing similar features) with the `explore` subagent or grep/glob/read. The PRD must reflect what exists.
2. **Interrogate.**
   - *Interactive* (`/pickle-prd`): ask the user the 3–6 questions that actually change the design (problem, users, scope boundaries, constraints, "done" criteria). Ask them together, not one by one.
   - *Autonomous* (inside the loop): do NOT stop to ask. Infer the most reasonable answers from the request and the code, and record them as explicit assumptions.
3. **Write `prd.md`** with these sections:
   - **Problem & goal** (2–4 sentences)
   - **Users / scenarios**
   - **Requirements**: numbered, each testable (`R1`, `R2`, …), split into must / should
   - **Non-goals**: what we are deliberately NOT doing
   - **Constraints & assumptions**: stack, compatibility, perf, security, anything inferred
   - **Acceptance criteria**: concrete checks (commands, behaviors) that prove it's done
   - **Risks & open questions**
4. **Self-review**: is every requirement testable? Anything vague ("fast", "nice", "robust")? Replace it with a number or a behavior.
5. Call `pickle_set_phase` with `breakdown`.

Scale to the task: a one-line bugfix gets a 5-line PRD.
