// Pickle Rick loop engine for opencode.
// Pure module: no opencode imports, so it can be unit-tested with a mock client.
import fs from "node:fs"
import path from "node:path"

export const PHASES = ["prd", "breakdown", "research", "plan", "implement", "refactor"] as const
export type Phase = (typeof PHASES)[number]

export interface TokenTotals {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  // Billable new tokens: input + output + reasoning. Cache reads/writes are kept
  // separate because providers bill them at a different rate.
  total: number
}

export interface LoopState {
  id: string
  name: string
  task: string
  active: boolean
  sessionID: string
  iteration: number
  maxIterations: number
  maxTimeMs: number
  maxTokens: number
  workerTimeoutMs: number
  completionPromise: string
  phase: Phase
  startedAt: number
  updatedAt: number
  lastHandledMessageID?: string
  stopReason?: string
  jar?: boolean
  tokensUsed?: TokenTotals
  lastTurnTokens?: number
  mortyTokens?: number
}

export interface ParsedArgs {
  task: string
  maxIterations?: number
  maxTimeMin?: number
  maxTokens?: number
  workerTimeoutSec?: number
  name?: string
  completionPromise?: string
  resume?: boolean
  resumePath?: string
  errors: string[]
}

const DEFAULTS = { maxIterations: 5, maxTimeMin: 60, maxTokens: 2_000_000, workerTimeoutSec: 1200, promise: "DONE" }
const HARD_CAP_ITERATIONS = 100
const unwrap = (r: any) => (r && typeof r === "object" && "data" in r ? r.data : r)

// ---------- argument parsing ----------

export function tokenize(raw: string): string[] {
  const out: string[] = []
  let cur = ""
  let q: string | null = null
  let started = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const next = raw[i + 1]
    if (q) {
      // a quote closes only when followed by whitespace/end, so apostrophes inside quotes survive
      if (c === q && (next === undefined || /\s/.test(next))) q = null
      else cur += c
      continue
    }
    if (!started && (c === '"' || c === "'")) {
      q = c
      started = true
      continue
    }
    if (/\s/.test(c)) {
      if (started) {
        out.push(cur)
        cur = ""
        started = false
      }
      continue
    }
    cur += c
    started = true
  }
  if (started) out.push(cur)
  return out
}

export function parseArgs(raw: string): ParsedArgs {
  const toks = tokenize(raw.trim())
  const res: ParsedArgs = { task: "", errors: [] }
  const task: string[] = []
  const num = (flag: string, v: string | undefined): number | undefined => {
    const n = Number(v)
    if (!v || !Number.isFinite(n) || n <= 0) {
      res.errors.push(`${flag} needs a positive number (got "${v ?? ""}")`)
      return undefined
    }
    return Math.floor(n)
  }
  for (let i = 0; i < toks.length; i++) {
    let t = toks[i]
    let inline: string | undefined
    const eq = t.startsWith("--") ? t.indexOf("=") : -1
    if (eq > 0) {
      inline = t.slice(eq + 1)
      t = t.slice(0, eq)
    }
    const val = () => (inline !== undefined ? inline : toks[++i])
    switch (t) {
      case "--max-iterations": res.maxIterations = num(t, val()); break
      case "--max-time": res.maxTimeMin = num(t, val()); break
      case "--max-tokens": {
        const v = val()
        const n = parseTokenLimit(v)
        if (n === undefined) res.errors.push(`${t} needs a number like 500k or 2m, or "off" (got "${v ?? ""}")`)
        else res.maxTokens = n
        break
      }
      case "--worker-timeout": res.workerTimeoutSec = num(t, val()); break
      case "--name": res.name = val(); break
      case "--completion-promise": res.completionPromise = val(); break
      case "--resume": {
        res.resume = true
        const nxt = inline !== undefined ? inline : toks[i + 1]
        if (nxt && !nxt.startsWith("--")) {
          res.resumePath = nxt
          if (inline === undefined) i++
        }
        break
      }
      default: task.push(toks[i])
    }
  }
  res.task = task.join(" ").trim()
  return res
}

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task"

export function extractPromise(text: string): string | null {
  const m = [...text.matchAll(/<promise>([\s\S]*?)<\/promise>/g)]
  return m.length ? m[m.length - 1][1].trim() : null
}

// "500k" / "1.5m" / "200000" / "off" -> absolute token limit. Returns undefined
// when the value is not a valid limit, so the caller can report a usage error.
export function parseTokenLimit(v: string | undefined): number | undefined {
  const s = String(v ?? "").trim().toLowerCase()
  if (!s) return undefined
  if (["off", "none", "unlimited", "0"].includes(s)) return 0
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s)
  if (!m) return undefined
  const n = Math.floor(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1))
  return n > 0 ? n : undefined
}

export const fmtNum = (n: number) => Math.round(n).toLocaleString("en-US")

const EMPTY_TOKENS = (): TokenTotals => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

// Sum the per-step usage of every assistant message created at/after `since`.
// Each assistant message carries the usage of the step that produced it, so the
// sum matches the session totals opencode keeps. Messages without usage (aborted
// or older mock clients) contribute nothing.
export function tokenTotals(msgs: any[], since = 0): TokenTotals {
  const t = EMPTY_TOKENS()
  for (const m of msgs ?? []) {
    const info = m?.info ?? m
    if (info?.role !== "assistant") continue
    const created = info?.time?.created ?? 0
    if (since && created && created < since) continue
    const u = info?.tokens
    if (!u) continue
    t.input += u.input ?? 0
    t.output += u.output ?? 0
    t.reasoning += u.reasoning ?? 0
    t.cacheRead += u.cache?.read ?? 0
    t.cacheWrite += u.cache?.write ?? 0
  }
  t.total = t.input + t.output + t.reasoning
  return t
}

// ---------- engine ----------

export interface EngineDeps {
  client: any
  directory: string
  now?: () => number
}

export function createEngine(deps: EngineDeps) {
  const { client, directory } = deps
  const now = deps.now ?? (() => Date.now())
  const root = path.join(directory, ".pickle-rick")
  const sessionsRoot = path.join(root, "sessions")
  const jarFile = path.join(root, "jar.json")
  const cache = new Map<string, LoopState>() // opencode sessionID -> active loop
  const interrupted = new Set<string>()
  const handling = new Set<string>()

  // Token accounting for the current task: parent session usage plus every
  // Morty child spawned for it, so a ticket's real cost is visible.
  const tokensUsed = (st: LoopState) => (st.tokensUsed?.total ?? 0) + (st.mortyTokens ?? 0)
  const budgetText = (st: LoopState) => {
    const used = tokensUsed(st)
    if (!st.maxTokens) return `${fmtNum(used)} used (no cap)`
    const pct = Math.min(100, Math.round((used / st.maxTokens) * 100))
    return `${fmtNum(used)} / ${fmtNum(st.maxTokens)} (${pct}%)`
  }

  // ----- logging / UI (never throw) -----
  const log = async (level: "debug" | "info" | "warn" | "error", message: string) => {
    try { await client?.app?.log?.({ body: { service: "pickle-rick", level, message } }) } catch {}
  }
  const toast = async (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    try { await client?.tui?.showToast?.({ body: { message, variant } }) } catch {}
  }

  // ----- persistence -----
  const dirOf = (st: LoopState) => path.join(sessionsRoot, st.id)
  const relDir = (st: LoopState) => path.relative(directory, dirOf(st)) || dirOf(st)
  const stateFile = (st: LoopState) => path.join(dirOf(st), "state.json")

  function save(st: LoopState) {
    st.updatedAt = now()
    fs.mkdirSync(dirOf(st), { recursive: true })
    const tmp = stateFile(st) + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2))
    fs.renameSync(tmp, stateFile(st))
  }

  function loadAll(): LoopState[] {
    if (!fs.existsSync(sessionsRoot)) return []
    const out: LoopState[] = []
    for (const d of fs.readdirSync(sessionsRoot)) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(sessionsRoot, d, "state.json"), "utf8"))) } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function findActive(sessionID: string): LoopState | undefined {
    const hit = cache.get(sessionID)
    if (hit?.active) return hit
    const disk = loadAll().find((s) => s.active && s.sessionID === sessionID)
    if (disk) cache.set(sessionID, disk)
    return disk
  }

  function newId(name: string): string {
    const base = `${new Date(now()).toISOString().slice(0, 10)}-${slugify(name)}`
    let id = base
    for (let n = 2; fs.existsSync(path.join(sessionsRoot, id)); n++) id = `${base}-${n}`
    return id
  }

  function scaffold(st: LoopState) {
    for (const sub of ["tickets", "research", "plans"]) fs.mkdirSync(path.join(dirOf(st), sub), { recursive: true })
    save(st)
  }

  const nonEmpty = (p: string) => fs.existsSync(p) && fs.readdirSync(p).some((f: string) => !f.startsWith("."))

  function inferPhase(st: LoopState): Phase {
    const d = dirOf(st)
    if (!fs.existsSync(path.join(d, "prd.md"))) return "prd"
    if (!nonEmpty(path.join(d, "tickets"))) return "breakdown"
    if (!nonEmpty(path.join(d, "research"))) return "research"
    if (!nonEmpty(path.join(d, "plans"))) return "plan"
    return "implement"
  }

  // ----- prompts -----
  function budgetLine(st: LoopState): string {
    const used = tokensUsed(st)
    if (!st.maxTokens) {
      return `• Tokens used by this task so far: ${fmtNum(used)}. Spend them like Rick's last battery: no redundant file reads, no full log dumps, targeted commands only.`
    }
    const left = Math.max(0, st.maxTokens - used)
    return `• Token budget: ${fmtNum(used)} / ${fmtNum(st.maxTokens)} used (${fmtNum(left)} left). Be economical — no redundant reads, no log dumps, targeted test commands. If you get close to the limit, finish the ticket in hand and stop with a short status instead of starting new work.`
  }

  function buildPrompt(st: LoopState): string {
    return [
      `🥒 PICKLE RICK LOOP — iteration ${st.iteration}/${st.maxIterations} · phase: ${st.phase} · session dir: ${relDir(st)}`,
      ``,
      st.task,
      budgetLine(st),
      ``,
      `── Loop rules (same every iteration) ──`,
      `• Your previous work persists in files and git history. FIRST read ${relDir(st)}/ (prd.md, tickets/, research/, plans/) and \`git status\`, then continue where you left off.`,
      `• Stay in persona: load the \`load-pickle-persona\` skill if you haven't in this session.`,
      `• Lifecycle — advance one phase at a time and record it with the \`pickle_set_phase\` tool:`,
      `  1 prd → skill prd-drafter → ${relDir(st)}/prd.md`,
      `  2 breakdown → skill ticket-manager → ${relDir(st)}/tickets/NNN-slug.md`,
      `  3 research → skills code-researcher + research-reviewer → ${relDir(st)}/research/`,
      `  4 plan → skills implementation-planner + plan-reviewer → ${relDir(st)}/plans/`,
      `  5 implement → skill code-implementer; delegate tickets to Morty with \`pickle_send_to_morty\`, then verify yourself`,
      `  6 refactor → skill ruthless-refactorer`,
      `• Scale the ceremony to the task: for something trivial, a 5-line PRD and one ticket is plenty.`,
      `• Verify with real commands (tests, linters, build) before claiming anything works.`,
      `• ONLY when the work is genuinely complete and verified, end your reply with exactly: <promise>${st.completionPromise}</promise>`,
      `  Never write that tag anywhere else, never quote it, and never emit it falsely. Not done yet? Just keep working.`,
    ].join("\n")
  }

  // ----- lifecycle -----
  async function finish(st: LoopState, reason: string) {
    st.active = false
    st.stopReason = reason
    save(st)
    cache.delete(st.sessionID)
    const ok = reason === "completed"
    const tok = tokensUsed(st)
    await toast(`🥒 ${ok ? "Done" : "Loop stopped"}: ${reason} (iteration ${st.iteration}/${st.maxIterations}${tok ? ` · ${fmtNum(tok)} tokens` : ""})`, ok ? "success" : "warning")
    await log("info", `loop ${st.id} finished: ${reason}`)
    if (ok && st.jar) await nextFromJar(st.sessionID)
  }

  function dispatch(st: LoopState, ctx?: { agent?: string; model?: any }) {
    const body: any = { parts: [{ type: "text", text: buildPrompt(st) }] }
    if (ctx?.agent) body.agent = ctx.agent
    if (ctx?.model) body.model = ctx.model
    void toast(`🥒 Iteration ${st.iteration}/${st.maxIterations} · ${st.phase}`)
    // Fire and forget: the call resolves only when the whole turn ends, and the next
    // session.idle event is what drives the loop.
    Promise.resolve(client.session.prompt({ path: { id: st.sessionID }, body })).then(
      (r: any) => { if (r?.error) void finish(st, `failed: ${JSON.stringify(r.error).slice(0, 120)}`) },
      (e: any) => void finish(st, `failed: ${String(e?.message ?? e).slice(0, 120)}`),
    )
  }

  async function onIdle(sessionID: string) {
    const st = findActive(sessionID)
    if (!st || handling.has(sessionID)) return
    handling.add(sessionID)
    try {
      if (interrupted.delete(sessionID)) return await finish(st, "interrupted")
      const msgs: any[] = unwrap(await client.session.messages({ path: { id: sessionID } })) ?? []
      const lastAssistant = [...msgs].reverse().find((m) => m.info?.role === "assistant")
      if (!lastAssistant) return
      // Refresh usage on every finished turn, before any early return.
      const usage = tokenTotals(msgs, st.startedAt)
      const prevTotal = st.tokensUsed?.total ?? 0
      st.tokensUsed = usage
      st.lastTurnTokens = Math.max(0, usage.total - prevTotal)
      save(st)
      if (lastAssistant.info.id === st.lastHandledMessageID) return // duplicate idle
      if (!lastAssistant.info.time?.completed && !lastAssistant.info.error) return // still streaming
      st.lastHandledMessageID = lastAssistant.info.id
      if (lastAssistant.info.error) {
        const name = lastAssistant.info.error.name ?? "error"
        return await finish(st, name === "MessageAbortedError" ? "interrupted" : `failed: ${name}`)
      }
      const text = (lastAssistant.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
      if (extractPromise(text) === st.completionPromise) return await finish(st, "completed")
      if (st.maxTokens > 0 && tokensUsed(st) >= st.maxTokens) return await finish(st, "max-tokens")
      if (st.iteration >= st.maxIterations) return await finish(st, "max-iterations")
      if (now() - st.startedAt > st.maxTimeMs) return await finish(st, "max-time")
      st.iteration++
      save(st)
      const lastUser = [...msgs].reverse().find((m) => m.info?.role === "user")
      dispatch(st, { agent: lastUser?.info?.agent, model: lastUser?.info?.model })
    } catch (e: any) {
      await log("error", `onIdle failed: ${e?.message ?? e}`)
    } finally {
      handling.delete(sessionID)
    }
  }

  async function handleEvent(event: any) {
    const p = event?.properties ?? {}
    switch (event?.type) {
      case "session.idle":
        return onIdle(p.sessionID)
      case "session.error": {
        const sid = p.sessionID
        if (sid && findActive(sid) && p.error?.name === "MessageAbortedError") interrupted.add(sid)
        return
      }
      case "session.deleted": {
        const sid = p.info?.id ?? p.sessionID
        const st = sid && findActive(sid)
        if (st) await finish(st, "session-deleted")
        return
      }
    }
  }

  // ----- commands (called by plugin tools) -----
  function startFromRaw(sessionID: string, raw: string): string {
    const a = parseArgs(raw)
    if (a.errors.length) return `🥒 Jerry-level input, Morty: ${a.errors.join("; ")}`
    let st: LoopState | undefined
    if (a.resume) {
      st = a.resumePath
        ? loadAll().find((s) => s.id === path.basename(a.resumePath!.replace(/\/+$/, "")))
        : loadAll()[0]
      if (!st) return "🥒 Nothing to resume. Run /pickle-prd or /pickle \"<task>\" first."
      st.iteration = 1
      st.startedAt = now()
      st.lastHandledMessageID = undefined
      st.stopReason = undefined
    } else {
      if (!a.task) return `🥒 Usage: /pickle "<task>" [--max-iterations N] [--max-time MIN] [--max-tokens N|off] [--worker-timeout SEC] [--name SLUG] [--completion-promise TEXT] [--resume [PATH]]`
      const name = a.name ?? a.task
      st = {
        id: newId(name), name: slugify(name), task: a.task, active: true, sessionID, iteration: 1,
        maxIterations: DEFAULTS.maxIterations, maxTimeMs: DEFAULTS.maxTimeMin * 60_000,
        maxTokens: DEFAULTS.maxTokens,
        workerTimeoutMs: DEFAULTS.workerTimeoutSec * 1000, completionPromise: DEFAULTS.promise,
        phase: "prd", startedAt: now(), updatedAt: now(),
      }
      scaffold(st)
    }
    const prev = findActive(sessionID)
    if (prev && prev.id !== st.id) { prev.active = false; prev.stopReason = "superseded"; save(prev) }
    st.active = true
    st.sessionID = sessionID
    if (a.maxIterations) st.maxIterations = Math.min(a.maxIterations, HARD_CAP_ITERATIONS)
    if (a.maxTimeMin) st.maxTimeMs = a.maxTimeMin * 60_000
    if (a.maxTokens !== undefined) st.maxTokens = a.maxTokens
    if (a.workerTimeoutSec) st.workerTimeoutMs = a.workerTimeoutSec * 1000
    if (a.completionPromise) st.completionPromise = a.completionPromise
    st.phase = inferPhase(st)
    save(st)
    cache.set(sessionID, st)
    const limit = st.maxTokens ? `${fmtNum(st.maxTokens)} tokens` : "no token cap"
    return [
      `🥒 Loop armed (${st.id}). Max ${st.maxIterations} iterations / ${Math.round(st.maxTimeMs / 60000)} min / ${limit}. Completion promise: ${st.completionPromise}`,
      `Session dir: ${relDir(st)}. Starting phase: ${st.phase}.`,
      `Begin NOW, in this turn. Load the \`load-pickle-persona\` skill first, then follow the prompt below.`,
      ``,
      buildPrompt(st),
    ].join("\n")
  }

  async function stop(sessionID: string): Promise<string> {
    const st = findActive(sessionID)
    if (!st) return "🥒 No active loop in this session. Nothing to eat."
    await finish(st, "cancelled")
    return `🥒 Loop ${st.id} cancelled at iteration ${st.iteration}. Work so far is in ${relDir(st)}/ and git.`
  }

  function initPrd(raw: string): string {
    const a = parseArgs(raw)
    const task = a.task || "untitled"
    const st: LoopState = {
      id: newId(a.name ?? task), name: slugify(a.name ?? task), task, active: false, sessionID: "", iteration: 0,
      maxIterations: DEFAULTS.maxIterations, maxTimeMs: DEFAULTS.maxTimeMin * 60_000,
      maxTokens: DEFAULTS.maxTokens,
      workerTimeoutMs: DEFAULTS.workerTimeoutSec * 1000, completionPromise: DEFAULTS.promise,
      phase: "prd", startedAt: now(), updatedAt: now(),
    }
    scaffold(st)
    return `Session created: ${relDir(st)}/ — write the PRD to ${relDir(st)}/prd.md. The loop is NOT running; the user starts it with \`/pickle --resume\`.`
  }

  function setPhase(sessionID: string, phase: string): string {
    const st = findActive(sessionID)
    if (!st) return "No active Pickle Rick loop in this session."
    if (!PHASES.includes(phase as Phase)) return `Unknown phase "${phase}". Valid: ${PHASES.join(", ")}`
    st.phase = phase as Phase
    save(st)
    return `Phase → ${phase} (iteration ${st.iteration}/${st.maxIterations}).`
  }

  function status(sessionID: string): string {
    const st = findActive(sessionID) ?? loadAll()[0]
    if (!st) return "🥒 No Pickle Rick sessions in this project yet."
    const mins = Math.round((now() - st.startedAt) / 60000)
    return [
      `Session: ${st.id} (${st.active ? "ACTIVE" : `stopped: ${st.stopReason ?? "not started"}`})`,
      `Dir: ${relDir(st)}`,
      `Phase: ${st.phase} · iteration ${st.iteration}/${st.maxIterations} · ${mins}/${Math.round(st.maxTimeMs / 60000)} min`,
      `Tokens: ${budgetText(st)}${st.lastTurnTokens ? ` · last turn +${fmtNum(st.lastTurnTokens)}` : ""}${st.mortyTokens ? ` · Morty ${fmtNum(st.mortyTokens)}` : ""}`,
      `Promise: ${st.completionPromise}`,
      `Task: ${st.task}`,
    ].join("\n")
  }

  function compactionContext(sessionID: string): string | undefined {
    const st = findActive(sessionID)
    if (!st) return undefined
    return `## Pickle Rick loop (must survive compaction)\nTask: ${st.task}\nSession dir: ${relDir(st)} (prd.md, tickets/, research/, plans/)\nPhase: ${st.phase}, iteration ${st.iteration}/${st.maxIterations}\nTokens: ${budgetText(st)}\nEnd with <promise>${st.completionPromise}</promise> only when truly complete and verified.`
  }

  // ----- the Jar -----
  const readJar = (): { id: string; task: string; addedAt: number }[] => {
    try { return JSON.parse(fs.readFileSync(jarFile, "utf8")) } catch { return [] }
  }
  const writeJar = (j: unknown) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(jarFile, JSON.stringify(j, null, 2)) }

  function jarAdd(task: string): string {
    const t = task.trim() || loadAll()[0]?.task || ""
    if (!t) return "🥒 Nothing to jar. Pass a task: /add-to-pickle-jar \"<task>\"."
    const jar = readJar()
    jar.push({ id: `${jar.length + 1}-${slugify(t).slice(0, 20)}`, task: t, addedAt: now() })
    writeJar(jar)
    return `🥒 Added to the Jar (${jar.length} queued): ${t}`
  }

  function popJar(sessionID: string): LoopState | undefined {
    const jar = readJar()
    const item = jar.shift()
    if (!item) return undefined
    writeJar(jar)
    const st: LoopState = {
      id: newId(item.task), name: slugify(item.task), task: item.task, active: true, sessionID, iteration: 1,
      maxIterations: DEFAULTS.maxIterations, maxTimeMs: DEFAULTS.maxTimeMin * 60_000,
      maxTokens: DEFAULTS.maxTokens,
      workerTimeoutMs: DEFAULTS.workerTimeoutSec * 1000, completionPromise: DEFAULTS.promise,
      phase: "prd", startedAt: now(), updatedAt: now(), jar: true,
    }
    scaffold(st)
    cache.set(sessionID, st)
    return st
  }

  async function nextFromJar(sessionID: string) {
    const st = popJar(sessionID)
    if (!st) return void (await toast("🥒 The Jar is empty. All tasks done.", "success"))
    dispatch(st)
  }

  function jarOpen(sessionID: string): string {
    const left = readJar().length
    if (!left) return "🥒 The Jar is empty."
    const st = popJar(sessionID)!
    return `🥒 Opening the Jar: ${left} task(s) queued. Starting the first one; the rest run automatically as each completes.\nBegin NOW. Load \`load-pickle-persona\`, then:\n\n${buildPrompt(st)}`
  }

  // ----- Morty workers -----
  async function sendToMorty(parentID: string, ticket: string, instructions: string): Promise<string> {
    const st = findActive(parentID)
    if (st && st.maxTokens > 0 && tokensUsed(st) >= st.maxTokens) {
      return `🥒 Token budget exhausted (${budgetText(st)}). Not spawning Morty for ${ticket}: finish it yourself, or raise the cap with /pickle --resume --max-tokens 4m.`
    }
    const timeoutMs = st?.workerTimeoutMs ?? DEFAULTS.workerTimeoutSec * 1000
    // Morty runs in a child session with its own context. Inherit the parent's
    // model (and variant) so the worker does not fall back to the default model;
    // the agent stays "morty" so the worker prompt/persona is the Morty one.
    let parentModel: any
    try {
      const pmsgs: any[] = unwrap(await client.session.messages({ path: { id: parentID } })) ?? []
      parentModel = [...pmsgs].reverse().find((m) => m.info?.role === "assistant" && m.info?.model)?.info?.model
    } catch {}
    const child = unwrap(
      await client.session.create({ body: { parentID, title: `🥒 Morty: ${ticket}`, agent: "morty", model: parentModel } }),
    )
    if (!child?.id) return `Morty failed to spawn for ${ticket}.`
    const childUsage = async (id: string): Promise<TokenTotals | undefined> => {
      try { return tokenTotals(unwrap(await client.session.messages({ path: { id } })) ?? []) } catch { return undefined }
    }
    const account = async (id: string) => {
      const usage = await childUsage(id)
      if (st && usage?.total) {
        st.mortyTokens = (st.mortyTokens ?? 0) + usage.total
        save(st)
      }
      return usage
    }
    const where = st ? relDir(st) : ".pickle-rick/sessions/<session>"
    const text = [
      `You are Morty, a worker. Implement exactly ONE ticket: ${ticket}`,
      `Session dir: ${where} (ticket in tickets/, plan in plans/, research in research/). Read them first.`,
      ``,
      instructions,
      ``,
      `Rules: do only this ticket, run the tests, update the ticket file's status, and finish with a short report: files changed, commands run, results, open issues.`,
    ].join("\n")
    let timer: any
    const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs) })
    try {
      const r: any = await Promise.race([client.session.prompt({ path: { id: child.id }, body: { agent: "morty", parts: [{ type: "text", text }] } }), timeout])
      const usage = await account(child.id)
      if (r === "timeout") {
        try { await client.session.abort({ path: { id: child.id } }) } catch {}
        return `Morty timed out on ${ticket} after ${Math.round(timeoutMs / 1000)}s and was aborted (child session ${child.id}, ${usage?.total ? `${fmtNum(usage.total)} tokens` : "usage unknown"}). Check the files, then retry or finish it yourself.`
      }
      const data = unwrap(r)
      const out = (data?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").trim()
      const cost = usage?.total ? `\n(child used ${fmtNum(usage.total)} tokens · ${fmtNum(usage.cacheRead)} cache read)` : ""
      return `Morty finished ${ticket} (child session ${child.id}):\n${out || "(no report)"}${cost}`
    } catch (e: any) {
      return `Morty crashed on ${ticket}: ${e?.message ?? e}`
    } finally {
      clearTimeout(timer)
    }
  }

  return { handleEvent, startFromRaw, stop, initPrd, setPhase, status, compactionContext, jarAdd, jarOpen, sendToMorty, buildPrompt }
}
