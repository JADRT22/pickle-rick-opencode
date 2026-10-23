// 🥒 Pickle Rick for opencode v2 — loop engine, tools and hooks.
// The loop logic lives in ../pickle-rick/core.ts (pure, unit-tested) and is
// written against the V1 `client` RPC shape; ../pickle-rick/adapter.ts exposes
// that shape on top of the V2 plugin context.
import { execSync } from "node:child_process"
import { Plugin } from "@opencode/plugin"
import { createEngine, PHASES } from "../pickle-rick/core"
import { createV1Client } from "../pickle-rick/adapter"

const JSON_EMPTY = { type: "object", properties: {}, additionalProperties: false } as const

export default Plugin.define({
  id: "pickle-rick",
  async setup(ctx) {
    const engine = createEngine({ client: createV1Client(ctx), directory: ctx.location.directory })

    // Keep the loop alive through context compaction.
    await ctx.session.hook("compaction", (event: any) => {
      const extra = engine.compactionContext(event?.sessionID)
      if (extra && Array.isArray(event?.system)) event.system.push({ type: "text", text: extra })
    })

    // Refuse a start on a dirty tree unless the user asked for it: the loop writes
    // code, and a dirty tree makes its own diffs impossible to review.
    const dirtyGuard = (raw: string): string | undefined => {
      if (/--allow-dirty\b/.test(raw) || /--resume\b/.test(raw)) return undefined
      try {
        const out = execSync("git status --porcelain", {
          cwd: ctx.location.directory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim()
        if (!out) return undefined
        const lines = out.split("\n")
        return `🥒 Working tree is dirty (${lines.length} file${lines.length === 1 ? "" : "s"}):\n${lines.slice(0, 10).join("\n")}${lines.length > 10 ? "\n…" : ""}\nCommit or stash first, or start with \`--allow-dirty\` if this is intentional.`
      } catch {
        return undefined // not a git repo: nothing to guard
      }
    }

    // Register the tools. V2: JSON-Schema input, execute returns {content}.
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "pickle_start",
        description:
          "Start (or resume) the Pickle Rick loop for this session. Pass the raw argument string exactly as typed after /pickle.",
        input: {
          type: "object",
          properties: {
            raw: { type: "string", description: 'Raw args, e.g. "Refactor auth" --max-iterations 8 --completion-promise "SHIPPED"' },
          },
          required: ["raw"],
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => ({
          content: dirtyGuard(String(input.raw ?? "")) ?? engine.startFromRaw(toolCtx.sessionID, input.raw),
        }),
      })
      editor.add({
        name: "pickle_stop",
        description: "Cancel the active Pickle Rick loop in this session (/eat-pickle).",
        input: JSON_EMPTY,
        execute: async (_input: any, toolCtx: any) => ({ content: await engine.stop(toolCtx.sessionID) }),
      })
      editor.add({
        name: "pickle_status",
        description: "Show the Pickle Rick loop state: session dir, phase, iteration, limits, tokens, tickets. Use it to find the session directory.",
        input: JSON_EMPTY,
        execute: async (_input: any, toolCtx: any) => ({ content: engine.status(toolCtx.sessionID) }),
      })
      editor.add({
        name: "pickle_set_phase",
        description: `Record the current lifecycle phase of the loop. One of: ${PHASES.join(", ")}.`,
        input: {
          type: "object",
          properties: { phase: { type: "string", description: "prd | breakdown | research | plan | implement | refactor" } },
          required: ["phase"],
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => ({ content: engine.setPhase(toolCtx.sessionID, input.phase) }),
      })
      editor.add({
        name: "pickle_init_prd",
        description: "Create a Pickle Rick session directory for interactive PRD drafting without starting the loop (/pickle-prd).",
        input: {
          type: "object",
          properties: { raw: { type: "string", description: "The feature/task description" } },
          required: ["raw"],
          additionalProperties: false,
        },
        execute: async (input: any) => ({ content: engine.initPrd(input.raw) }),
      })
      editor.add({
        name: "pickle_jar_add",
        description: "Save a task in the Pickle Jar for later (/add-to-pickle-jar). Empty task = reuse the latest session's task.",
        input: {
          type: "object",
          properties: { task: { type: "string", description: "Task description (may be empty)" } },
          additionalProperties: false,
        },
        execute: async (input: any) => ({ content: engine.jarAdd(input.task ?? "") }),
      })
      editor.add({
        name: "pickle_jar_list",
        description: "List the tasks queued in the Pickle Jar (/pickle-jar-list).",
        input: JSON_EMPTY,
        execute: async () => ({ content: engine.jarList() }),
      })
      editor.add({
        name: "pickle_jar_open",
        description: "Open the Pickle Jar and run every queued task, one loop after another (/pickle-jar-open).",
        input: JSON_EMPTY,
        execute: async (_input: any, toolCtx: any) => ({ content: engine.jarOpen(toolCtx.sessionID) }),
      })
      editor.add({
        name: "pickle_sessions",
        description: "List every Pickle Rick session in this project with state, phase and token usage.",
        input: JSON_EMPTY,
        execute: async () => ({ content: engine.listSessions() }),
      })
      editor.add({
        name: "pickle_clean",
        description: "Delete finished Pickle Rick sessions older than N days (default 7). Active loops are never removed.",
        input: {
          type: "object",
          properties: { keepDays: { type: "number", description: "Keep sessions updated in the last N days (default 7)" } },
          additionalProperties: false,
        },
        execute: async (input: any) => ({ content: engine.cleanSessions(input.keepDays) }),
      })
      editor.add({
        name: "pickle_send_to_morty",
        description:
          "Spawn a Morty worker (isolated child session, own context, timeout) to implement ONE ticket. Empty ticket = next open ticket. Returns Morty's report.",
        input: {
          type: "object",
          properties: {
            ticket: { type: "string", description: "Ticket id or filename (e.g. 003-add-dark-mode), or empty for the next open ticket" },
            instructions: { type: "string", description: "Extra instructions for Morty: scope, constraints, verification commands" },
          },
          required: ["instructions"],
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => ({
          content: await engine.sendToMorty(toolCtx.sessionID, input.ticket ?? "", input.instructions ?? ""),
        }),
      })
    })

    // Replaces Gemini's AfterAgent hook: when a turn ends, re-prompt until the
    // <promise> token, max-iterations or max-time.
    //
    // v2.1.x does NOT emit `session.idle` (the V1 event core.ts was written for).
    // The turn-completion signal is `session.execution.succeeded`; a failed or
    // interrupted execution also ends the turn, so all three drive onIdle and
    // core re-reads the last assistant message (which carries .error) itself.
    // Event payloads ride in `.data`; core wants `{type, properties}`.
    const translate = (e: any): any => {
      const data = e?.data ?? e?.properties ?? {}
      switch (e?.type) {
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          return { type: "session.idle", properties: { sessionID: data.sessionID } }
        case "session.error":
          return { type: "session.error", properties: data }
        case "session.deleted":
          return { type: "session.deleted", properties: data }
        default:
          return undefined
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const normalized = translate(event)
          if (normalized) await engine.handleEvent(normalized)
        }
      } catch {
        // Subscription aborted on unload
      }
    })()

    return () => controller.abort()
  },
})
