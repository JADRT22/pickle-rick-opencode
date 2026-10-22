---
name: ruthless-refactorer
description: Senior-principal-level cleanup pass — remove AI slop, dead code and duplication, simplify complex logic, keep behavior identical. Use after implementation passes verification.
---

# Ruthless Refactorer

Only runs on code that already works and is covered by passing tests. **Behavior must not change.**

## Hunt list
- Comments that restate the code, banner comments, leftover TODO/debug prints
- Dead code, unused imports/params/exports, commented-out blocks
- Duplicated logic → extract once, name it well
- Over-engineering: single-use abstractions, needless config/flags, wrapper-around-a-wrapper
- Deep nesting and long functions → early returns, smaller units
- Inconsistent naming or patterns vs. the rest of the codebase
- Error handling that swallows or over-catches

## Process
1. Establish the baseline: run the full tests/linter/build and note they pass.
2. Scope to the files changed in this session (`git diff --stat` against the starting point). Don't wander through the whole repo.
3. Refactor in small steps; re-run tests after each step. If something breaks, revert that step.
4. Finish with a before/after summary: lines removed, duplications merged, anything you left alone and why.
5. Final full verification, then emit the completion promise.
