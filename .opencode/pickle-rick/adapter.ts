// V1-shaped adapter over the opencode v2 plugin context.
//
// core.ts is written against the V1 client RPC shape, so this module is the only
// place that knows about v2 (`ctx.session.prompt/context/interrupt`). Keeping it
// separate means the engine stays host-agnostic and this boundary gets its own
// tests without importing `@opencode/plugin`.

export interface V1Part {
  type: string
  text?: string
}

export interface V1Message {
  info: any
  parts: V1Part[]
}

export interface V1Client {
  app: { log(input: { body: { service: string; level: string; message: string } }): Promise<void> }
  tui: { showToast(input: { body: { message: string; variant?: string } }): Promise<void> }
  session: {
    prompt(input: { path: { id: string }; body: { parts: V1Part[]; agent?: string; model?: any } }): Promise<any>
    messages(input: { path: { id: string } }): Promise<{ data: V1Message[] }>
    create(input: { body: { parentID?: string; title?: string; agent?: string; model?: any } }): Promise<any>
    abort(input: { path: { id: string } }): Promise<void>
  }
}

export interface AdapterSession {
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
  context(input: { sessionID: string }): Promise<any[]>
  create(input: { parentID?: string; title?: string; agent?: string; model?: any }): Promise<any>
  interrupt(input: { sessionID: string }): Promise<unknown>
  switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>
  switchModel?(input: { sessionID: string; model: any }): Promise<unknown>
}

export interface AdapterCtx {
  session: AdapterSession
}

export interface AdapterOptions {
  intervalMs?: number
  capMs?: number
  sleep?: (ms: number) => Promise<void>
}

export const POLL_CAP_MS = 45 * 60_000
export const POLL_INTERVAL_MS = 1500

// Flatten a v2 message (Session.Message.Info union) into the V1 {info, parts}
// shape core.ts reads: info.role/id/time/error/agent/model + parts[{type,text}].
export function mapMessage(m: any): V1Message {
  const role = m?.type === "user" ? "user" : m?.type === "assistant" ? "assistant" : m?.type
  // v2 assistant error is a StructuredError ({type,message}); the aborted error
  // carries `name`. core.ts reads `.name`, so normalize type -> name.
  const err = m?.error ? { name: m.error.name ?? m.error.type, ...m.error } : undefined
  const parts: V1Part[] =
    m?.type === "assistant"
      ? (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => ({ type: "text", text: c.text }))
      : m?.type === "user"
        ? [{ type: "text", text: m.text }]
        : []
  return {
    info: {
      role,
      id: m?.id,
      time: m?.time,
      error: err,
      agent: m?.agent,
      model: m?.model,
      finish: m?.finish,
      tokens: m?.tokens,
      cost: m?.cost,
    },
    parts,
  }
}

// A v2 turn can end with `finish: "tool-calls"`, which is NOT the end of the
// reply: the model is invoked again after the tools run. Only a terminal turn
// (any finish other than "tool-calls") is a real reply.
export function terminalTurn(m: any): boolean {
  return !!m?.error || (m?.finish ? m.finish !== "tool-calls" : (m?.content ?? []).some((c: any) => c?.type === "text" && String(c?.text ?? "").trim()))
}

const textOfParts = (parts: V1Part[]) => (parts ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("\n")

export function createV1Client(ctx: AdapterCtx, opts: AdapterOptions = {}): V1Client {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS
  const capMs = opts.capMs ?? POLL_CAP_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const contextOf = async (sessionID: string): Promise<any[]> => {
    try { return (await ctx.session.context({ sessionID })) ?? [] } catch { return [] }
  }

  // Poll until a NEW terminal assistant message appears. Resolves undefined on
  // the cap so a slow or abandoned turn never fails the caller.
  const pollReply = async (sessionID: string, beforeID: string | undefined): Promise<any | undefined> => {
    const deadline = Date.now() + capMs
    while (Date.now() < deadline) {
      const msgs = await contextOf(sessionID)
      const last = [...msgs].reverse().find((m) => m?.type === "assistant")
      if (last && last.id !== beforeID && (last.time?.completed || last.error) && terminalTurn(last)) return last
      await sleep(intervalMs)
    }
    return undefined
  }

  return {
    app: {
      log: async ({ body }) => {
        try { console.error(`[pickle-rick:${body?.level}] ${body?.message}`) } catch {}
      },
    },
    tui: {
      showToast: async ({ body }) => {
        try { console.error(`[pickle-rick:toast:${body?.variant}] ${body?.message}`) } catch {}
      },
    },
    session: {
      // V1: {path:{id}, body:{parts, agent?, model?}} -> resolves with the turn's
      // assistant message ({data:{info,parts}}). v2 prompt resolves on admission,
      // so we admit, then poll for the reply.
      async prompt({ path, body }) {
        const sessionID = path.id
        const text = textOfParts(body?.parts)
        // v2 keeps agent/model on the session; only switch when explicitly asked.
        if (body?.agent) { try { await ctx.session.switchAgent?.({ sessionID, agent: body.agent }) } catch {} }
        if (body?.model?.id && body?.model?.providerID) { try { await ctx.session.switchModel?.({ sessionID, model: body.model }) } catch {} }
        const cur = await contextOf(sessionID)
        const beforeID = [...cur].reverse().find((m) => m?.type === "assistant")?.id
        // Admission errors (e.g. busy session) reject immediately.
        await ctx.session.prompt({ sessionID, text })
        const reply = await pollReply(sessionID, beforeID)
        return { data: reply ? mapMessage(reply) : { info: {}, parts: [] } }
      },
      // V1: {path:{id}} -> {data:[{info,parts}]}. v2 context() returns the flat list.
      async messages({ path }) {
        const msgs = await contextOf(path.id)
        return { data: msgs.map(mapMessage) }
      },
      // V1: {body:{parentID,title}} -> {data:{id,...}}. v2 also accepts agent and
      // model, which is how a Morty child inherits the parent's model instead of
      // silently falling back to the global default.
      async create({ body }) {
        const created = await ctx.session.create({
          parentID: body?.parentID,
          title: body?.title,
          agent: body?.agent,
          model: body?.model,
        })
        // Belt and braces: if create ignored the model, switch afterwards.
        if (created?.id && body?.model?.id && body?.model?.providerID) {
          try { await ctx.session.switchModel?.({ sessionID: created.id, model: body.model }) } catch {}
        }
        return { data: created }
      },
      // V1 abort -> v2 interrupt.
      async abort({ path }) {
        await ctx.session.interrupt({ sessionID: path.id })
      },
    },
  }
}
