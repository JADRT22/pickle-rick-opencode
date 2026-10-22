# Pickle Rick for opencode 🥒

**English** · [Português (Brasil)](README.pt-BR.md)

Port of [pickle-rick-extension](https://github.com/galdawave/pickle-rick-extension) (Gemini CLI) to **opencode**: Ralph Wiggum's autonomous loop plus the PRD → tickets → research → plan → implementation → refactor lifecycle, with Rick in charge and Mortys as workers.

Works with **any model/provider** configured in opencode — the loop re-prompts the same session, so it inherits the agent and model you are already using (no built-in model, no Gemini dependency).

> Written against the opencode **v2 plugin API** (`Plugin.define` + `setup(ctx)`, `@opencode/plugin` package), tested on **opencode v2.1.3**. The engine (`core.ts`) is pure and API-agnostic; only the shim talks to the host.

## Installation

```sh
./install.sh /path/to/project   # this project only
./install.sh --global           # into ~/.config/opencode
./install.sh --help             # usage
```

Restart opencode and run `/help-pickle`. State and artifacts live in `.pickle-rick/sessions/<session>/` inside the project (the installer adds `.pickle-rick/` to `.gitignore`; that step does not apply to `--global`).

Manual install: copy the contents of `.opencode/` into the project's `.opencode/` (or `~/.config/opencode/`), keeping the structure (`plugins/`, `pickle-rick/`, `commands/`, `agents/`, `skills/`).

## Usage

| Command | What it does |
|---|---|
| `/pickle "task" [--max-iterations N] [--max-time MIN] [--max-tokens N\|off] [--worker-timeout SEC] [--name SLUG] [--completion-promise TEXT] [--resume [PATH]]` | Starts the loop (defaults: 5 iterations, 60 min, 2M tokens, 20 min per Morty, promise `DONE`) |
| `/pickle-prd "idea"` | Drafts the PRD interactively; then `/pickle --resume` |
| `/eat-pickle` | Cancels the loop |
| `/add-to-pickle-jar "task"` | Queues a task in the "Jar" |
| `/pickle-jar-open` | Runs the queue, one loop after another |
| `/help-pickle` | Command cheat sheet |

Esc interrupts: the loop **stops** instead of re-prompting.

## Token budget

Every loop counts tokens per task — `input + output + reasoning`, with cache read/write shown separately — and adds whatever Mortys spend in their child sessions.

```sh
/pickle "refactor auth" --max-tokens 500k   # 500_000 tokens
/pickle "refactor auth" --max-tokens 1.5m   # 1_500_000
/pickle "refactor auth" --max-tokens off    # no cap
```

- Default cap: **2,000,000 tokens** per loop.
- When the cap is reached, the loop stops with `stopReason: "max-tokens"` instead of starting another iteration.
- `pickle_status` reports `Tokens: used / cap (percent)`, the last turn and the Morty total; the `🥒 Done` toast also carries the token count.
- Every loop prompt includes the remaining budget, so the model knows how much it has left and is told to avoid redundant reads and log dumps.
- The cap covers the whole loop, Morty children included: `pickle_send_to_morty` refuses to spawn when the budget is exhausted.

## How Gemini became opencode

| Gemini CLI (original) | opencode (this port) |
|---|---|
| `AfterAgent` hook that blocks the exit | v2 plugin listening for turn completion (`session.execution.succeeded`) and calling `ctx.session.prompt()` |
| `commands/*.toml` | `.opencode/commands/*.md` (`$ARGUMENTS` goes raw to the `pickle_start` tool, which parses the flags in code) |
| `skills/*` (`activate_skill`) | `.opencode/skills/*/SKILL.md` (native `skill` tool) |
| `GEMINI.md` (persona) | `load-pickle-persona` skill + rules re-injected on every loop prompt |
| `get_session.sh` / `update-state.js` scripts | `pickle_status` / `pickle_set_phase` tools |
| `/send-to-morty` (separate gemini process) | `pickle_send_to_morty` tool: child session with the `morty` agent, the parent's model, timeout and abort, plus the child's token usage in the report |
| `sessions/` in `~/.gemini/extensions/…` + `includeDirectories` | `.pickle-rick/` in the project (no extra configuration) |

Deliberate details:
- **Turn-end event translated**: on v2.1.x opencode **no longer emits `session.idle`**; it emits `session.execution.succeeded` / `.failed` / `.interrupted`. The shim translates those three (plus `session.error` and `session.deleted`) into the shape the engine already understands. The payload rides in `.data`, not `.properties`.
- **Dedupe**: the loop only advances when a *new and completed* assistant message appears (`time.completed`), so repeated events do not trigger extra iterations.
- **Preserves agent and model**: in v2 the session retains the agent/model across prompts; the re-prompt keeps exactly what you were using. Morty child sessions are created with the parent's model and the `morty` agent.
- **Token accounting**: usage is read from each assistant message (`tokens`) and summed from the loop start; the budget is enforced before the next re-prompt.
- **`<promise>` only counts on the last message** and must match the configured text.
- **Compaction**: the loop state is injected into the summary via `ctx.session.hook("compaction", …)`.

## Why it needs a persistent session

The loop only advances when a turn ends and the execution event reaches the plugin. In an **interactive session (TUI)** that is the normal flow. In a one-shot `opencode run`, the process may exit before the event is delivered — use the TUI for the autonomous loop.

## Security (read this)

The loop executes code and shell on its own. Run it in a branch/worktree or sandbox and **block pushes**. Example `opencode.jsonc` in the **v2** shape (`permissions` as a rule list, `shell` action):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" },
    { "action": "shell", "resource": "git diff *", "effect": "allow" },
    { "action": "shell", "resource": "git push *", "effect": "deny" }
  ]
}
```

The last matching rule wins. In v1 the names were `permission`, `bash` and `task`; in v2 they are `permissions`, `shell` and `subagent`. Mortys run in child sessions and also go through these rules; if opencode asks for approval, the loop waits for you.

## Tests and verification limits

- `node --experimental-strip-types --test test/core.test.ts` — 17 engine tests (arg parsing, `--max-tokens` parsing, token totals, `max-tokens` stop, loop until the promise, max-iterations/max-time, duplicate idle, interruption, Jar, Morty with timeout, model inheritance and usage) against a **mocked** client.
- **Tested inside a real opencode** (v2.1.3): end-to-end loop through a persistent server with `opencode/deepseek-v4.1-flash-free` → the turn-end event fired, the engine re-prompted and persisted `stopReason:"completed"` with the `🥒 Done` toast. Interruption persists `stopReason:"failed: aborted"`.
- Token budget (v2.1.3, live): `--max-tokens 1` stopped the loop at `stopReason:"max-tokens"` after 4,884 tokens, and `pickle_status` reported the same figure.
- Morty inheritance (v2.1.3, live): the child session had `agent: "morty"` and the parent's model (`opencode/glm-5.3-flash-free`); the report ended with `(child used 38,179 tokens · 126,080 cache read)`.
- Tools registered and executing on the host: `pickle_start`, `pickle_stop`, `pickle_status`, `pickle_set_phase`, `pickle_init_prd`, `pickle_jar_add`, `pickle_jar_open`, `pickle_send_to_morty`.
- Compatible with any opencode model; the test used a free model only to avoid spending credits.
- The skill texts are original, in the same spirit as the repo's; the original repo's skills can also be copied into `.opencode/skills/` (same `SKILL.md` format), replacing `run_shell_command`/`activate_skill` and the Gemini scripts with the tools above.
