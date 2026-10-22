// 🥒 Pickle Rick for opencode v2 — loop engine, tools and hooks.
// Ported from the V1 plugin API to the V2 `Plugin.define` shape.
// The loop logic lives in ../pickle-rick/core.ts (pure, unit-tested) and is
// unchanged: it is written against the V1 `client` RPC shape, so this file
// exposes a thin V1-shaped adapter on top of the V2 plugin context.
import { Plugin } from "@opencode/plugin"
import { createEngine, PHASES } from "../pickle-rick/core"

// How long the adapter waits for a turn to finish before resolving empty.
// Purely a leak-guard for abandoned/interrupted sessions; the real per-ticket
// timeout is enforced by core (workerTimeoutMs) and the loop caps by
// max-iterations / max-time on idle events.
const POLL_CAP_MS = 45 * 60_000
const POLL_INTERVAL_MS = 1500

// Flatten a v2 message (Session.Message.Info union) into the V1 {info, parts}
// shape core.ts reads: info.role/id/time/error/agent/model + parts[{type,text}].
function mapMessage(m: any) {
  const role = m?.type === "user" ? "user" : m?.type === "assistant" ? "assistant" : m?.type
  // v2 assistant error is a StructuredError ({type,message}); the aborted error
  // carries `name`. core.ts reads `.name`, so normalize type -> name.
  const err = m?.error ? { name: m.error.name ?? m.error.type, ...m.error } : undefined
  const parts =
    m?.type === "assistant"
      ? (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => ({ type: "text", text: c.text }))
      : m?.type === "user"
        ? [{ type: "text", text: m.text }]
        : []
  return { info: { role, id: m?.id, time: m?.time, error: err, agent: m?.agent, model: m?.model }, parts }
}

const textOfParts = (parts: any[]) => (parts ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n")

// Build the V1-shaped `client` core.ts expects, backed by the v2 ctx.
function makeV1Client(ctx: any) {
  // Poll the session until a NEW assistant message completes (or errors).
  // Resolves soft (empty) on the poll cap so it never fails a slow turn.
  const pollReply = async (sessionID: string, beforeID: string | undefined): Promise<any | undefined> => {
    const deadline = Date.now() + POLL_CAP_MS
    while (Date.now() < deadline) {
      let msgs: any[] = []
      try { msgs = (await ctx.session.context({ sessionID })) ?? [] } catch {}
      const last = [...msgs].reverse().find((m) => m?.type === "assistant")
      if (last && last.id !== beforeID && (last.time?.completed || last.error)) return last
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    return undefined
  }

  return {
    app: {
      log: async ({ body }: any) => {
        try { console.error(`[pickle-rick:${body?.level}] ${body?.message}`) } catch {}
      },
    },
    tui: {
      showToast: async ({ body }: any) => {
        try { console.error(`[pickle-rick:toast:${body?.variant}] ${body?.message}`) } catch {}
      },
    },
    session: {
      // V1: {path:{id}, body:{parts, agent?, model?}} -> resolves with the turn's
      // assistant message ({data:{info,parts}}). v2 prompt resolves on admission,
      // so we admit, then poll for the reply.
      async prompt({ path, body }: any) {
        const sessionID = path.id
        const text = textOfParts(body?.parts)
        // v2 keeps agent/model on the session; only switch when explicitly asked.
        if (body?.agent) { try { await ctx.session.switchAgent({ sessionID, agent: body.agent }) } catch {} }
        let beforeID: string | undefined
        try {
          const cur: any[] = (await ctx.session.context({ sessionID })) ?? []
          beforeID = [...cur].reverse().find((m) => m?.type === "assistant")?.id
        } catch {}
        // Admission errors (e.g. busy session) reject immediately.
        await ctx.session.prompt({ sessionID, text })
        const reply = await pollReply(sessionID, beforeID)
        return { data: reply ? mapMessage(reply) : { info: {}, parts: [] } }
      },
      // V1: {path:{id}} -> {data:[{info,parts}]}. v2 context() returns the flat list.
      async messages({ path }: any) {
        const msgs: any[] = (await ctx.session.context({ sessionID: path.id })) ?? []
        return { data: msgs.map(mapMessage) }
      },
      // V1: {body:{parentID,title}} -> {data:{id,...}}.
      async create({ body }: any) {
        const created = await ctx.session.create({ parentID: body?.parentID, title: body?.title })
        return { data: created }
      },
      // V1 abort -> v2 interrupt.
      async abort({ path }: any) {
        await ctx.session.interrupt({ sessionID: path.id })
      },
    },
  }
}

export default Plugin.define({
  id: "pickle-rick",
  async setup(ctx) {
    const engine = createEngine({ client: makeV1Client(ctx), directory: ctx.location.directory })

    // Keep the loop alive through context compaction.
    await ctx.session.hook("compaction", (event: any) => {
      const extra = engine.compactionContext(event?.sessionID)
      if (extra && Array.isArray(event?.system)) event.system.push({ type: "text", text: extra })
    })

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
        execute: async (input: any, toolCtx: any) => ({ content: engine.startFromRaw(toolCtx.sessionID, input.raw) }),
      })
      editor.add({
        name: "pickle_stop",
        description: "Cancel the active Pickle Rick loop in this session (/eat-pickle).",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input: any, toolCtx: any) => ({ content: await engine.stop(toolCtx.sessionID) }),
      })
      editor.add({
        name: "pickle_status",
        description: "Show the Pickle Rick loop state: session dir, phase, iteration, limits. Use it to find the session directory.",
        input: { type: "object", properties: {}, additionalProperties: false },
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
        name: "pickle_jar_open",
        description: "Open the Pickle Jar and run every queued task, one loop after another (/pickle-jar-open).",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input: any, toolCtx: any) => ({ content: engine.jarOpen(toolCtx.sessionID) }),
      })
      editor.add({
        name: "pickle_send_to_morty",
        description:
          "Spawn a Morty worker (isolated child session, own context, timeout) to implement ONE ticket. Returns Morty's report.",
        input: {
          type: "object",
          properties: {
            ticket: { type: "string", description: "Ticket id or filename, e.g. 003-add-dark-mode" },
            instructions: { type: "string", description: "Extra instructions for Morty: scope, constraints, verification commands" },
          },
          required: ["ticket", "instructions"],
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => ({
          content: await engine.sendToMorty(toolCtx.sessionID, input.ticket, input.instructions),
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
          const normalized = translate(event as any)
          if (normalized) await engine.handleEvent(normalized)
        }
      } catch {
        // Subscription aborted on unload
      }
    })()

    return () => controller.abort()
  },
})
