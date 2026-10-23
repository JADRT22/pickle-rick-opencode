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
  // Provider-reported spend in USD, summed from the assistant messages.
  cost: number
}

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
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
  mortyCost?: number
  // Heartbeat lets status spot a loop whose process died without finishing.
  heartbeatAt?: number
  warnedBudget?: boolean
  // Tokens burned per lifecycle phase, so status can show where the budget went.
  phaseTokens?: Record<string, number>
  mortyModel?: ModelRef
}

export interface ParsedArgs {
  task: string
  maxIterations?: number
  maxTimeMin?: number
  maxTokens?: number
  workerTimeoutSec?: number
  name?: string
  completionPromise?: string
  mortyModel?: ModelRef
  force?: boolean
  allowDirty?: boolean
  resume?: boolean
  resumePath?: string
  errors: string[]
}

const DEFAULTS = { maxIterations: 5, maxTimeMin: 60, maxTokens: 2_000_000, workerTimeoutSec: 1200, promise: "DONE" }
const HARD_CAP_ITERATIONS = 100
const STALE_MS = 15 * 60_000
const PRD_EXCERPT_LINES = 40
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
      case "--morty-model": {
        const v = val()
        const ref = parseModelRef(v)
        if (!ref) res.errors.push(`${t} needs provider/model (got "${v ?? ""}")`)
        else res.mortyModel = ref
        break
      }
      case "--force": res.force = true; break
      case "--allow-dirty": res.allowDirty = true; break
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
export const fmtCost = (n: number) => `$${(Math.round((n || 0) * 10_000) / 10_000).toFixed(4)}`

// "provider/model" (with an optional "#variant") -> ModelRef. Providers and models can
// contain dashes and dots, so split on the first slash and the last hash only.
export function parseModelRef(v: string | undefined): ModelRef | undefined {
  const s = String(v ?? "").trim()
  if (!s) return undefined
  const slash = s.indexOf("/")
  if (slash <= 0 || slash === s.length - 1) return undefined
  const providerID = s.slice(0, slash)
  const rest = s.slice(slash + 1)
  const hash = rest.lastIndexOf("#")
  if (hash > 0 && hash < rest.length - 1) return { providerID, id: rest.slice(0, hash), variant: rest.slice(hash + 1) }
  return { providerID, id: rest }
}

const EMPTY_TOKENS = (): TokenTotals => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 })

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
    t.cost += info?.cost ?? 0
    const u = info?.tokens
    if (!u) continue
    t.input += u.input ?? 0
    t.output += u.output ?? 0
    t.reasoning += u.reasoning ?? 0
    t.cacheRead += u.cache?.read ?? 0
    t.cacheWrite += u.cache?.write ?? 0
    t.cost += info?.cost ?? 0
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
  const costUsed = (st: LoopState) => (st.tokensUsed?.cost ?? 0) + (st.mortyCost ?? 0)
  const budgetText = (st: LoopState) => {
    const used = tokensUsed(st)
    const cost = costUsed(st) ? ` · ${fmtCost(costUsed(st))}` : ""
    if (!st.maxTokens) return `${fmtNum(used)} used (no cap)${cost}`
    const pct = Math.min(100, Math.round((used / st.maxTokens) * 100))
    return `${fmtNum(used)} / ${fmtNum(st.maxTokens)} (${pct}%)${cost}`
  }

  // ----- tickets -----
  // A ticket is "done" when its head carries `Status: done` (case-insensitive). The
  // lifecycle skills write that line; reading it is what keeps the loop from redoing work.
  const ticketFiles = (st: LoopState) => {
    try { return fs.readdirSync(path.join(dirOf(st), "tickets")).filter((f) => f.endsWith(".md")).sort() } catch { return [] }
  }
  const ticketStatus = (file: string, st: LoopState): string => {
    try {
      const head = fs.readFileSync(path.join(dirOf(st), "tickets", file), "utf8").slice(0, 2000)
      return (/^\s*status:\s*(\S+)/im.exec(head)?.[1] ?? "open").toLowerCase()
    } catch { return "open" }
  }
  const ticketList = (st: LoopState) => ticketFiles(st).map((file) => ({ file, status: ticketStatus(file, st) }))
  const nextTicket = (st: LoopState) => ticketList(st).find((t) => t.status !== "done")?.file
  const findTicket = (st: LoopState, ref: string) => {
    const all = ticketFiles(st)
    const base = (f: string) => f.replace(/\.md$/, "")
    return all.find((f) => f === ref || f === `${ref}.md` || base(f) === ref || f.startsWith(`${ref}`))
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

  const countFiles = (p: string) => {
    try { return fs.readdirSync(p).filter((f: string) => !f.startsWith(".")).length } catch { return 0 }
  }
  const nonEmpty = (p: string) => countFiles(p) > 0

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
    const cost = costUsed(st) ? ` (${fmtCost(costUsed(st))})` : ""
    if (!st.maxTokens) {
      return `• Tokens used by this task so far: ${fmtNum(used)}${cost}. Spend them like Rick's last battery: no redundant file reads, no full log dumps, targeted commands only.`
    }
    const left = Math.max(0, st.maxTokens - used)
    const pct = Math.round((used / st.maxTokens) * 100)
    const hot = used >= st.maxTokens * 0.8 ? ` ⚠ ${pct}% of the budget is gone: wrap up the ticket in hand.` : ""
    return `• Token budget: ${fmtNum(used)} / ${fmtNum(st.maxTokens)} used (${fmtNum(left)} left${cost}). Be economical — no redundant reads, no log dumps, targeted test commands. If you get close to the limit, finish the ticket in hand and stop with a short status instead of starting new work.${hot}`
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
    const cost = costUsed(st) ? ` · ${fmtCost(costUsed(st))}` : ""
    await toast(`🥒 ${ok ? "Done" : "Loop stopped"}: ${reason} (iteration ${st.iteration}/${st.maxIterations}${tok ? ` · ${fmtNum(tok)} tokens` : ""}${cost})`, ok ? "success" : "warning")
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
      if (st.lastTurnTokens) {
        st.phaseTokens = { ...(st.phaseTokens ?? {}) }
        st.phaseTokens[st.phase] = (st.phaseTokens[st.phase] ?? 0) + st.lastTurnTokens
      }
      st.heartbeatAt = now()
      save(st)
      if (st.maxTokens > 0 && !st.warnedBudget && tokensUsed(st) >= st.maxTokens * 0.8) {
        st.warnedBudget = true
        save(st)
        await toast(`🥒 ${fmtNum(tokensUsed(st))} of ${fmtNum(st.maxTokens)} tokens used (${Math.round((tokensUsed(st) / st.maxTokens) * 100)}%). Wrap up.`, "warning")
      }
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
      if (!a.task) return `🥒 Usage: /pickle "<task>" [--max-iterations N] [--max-time MIN] [--max-tokens N|off] [--worker-timeout SEC] [--morty-model PROVIDER/MODEL] [--name SLUG] [--completion-promise TEXT] [--allow-dirty] [--force] [--resume [PATH]]`
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
    if (prev && prev.active && prev.id !== st.id && !a.force && !a.resume) {
      const stale = now() - (prev.heartbeatAt ?? prev.updatedAt) > STALE_MS
      return `🥒 A loop is already running in this session: ${prev.id}${stale ? " (STALE — no activity for a while)" : ""}. Continue it with \`/pickle --resume\`, or replace it with \`--force\`.`
    }
    if (prev && prev.id !== st.id) { prev.active = false; prev.stopReason = "superseded"; save(prev) }
    st.active = true
    st.sessionID = sessionID
    st.heartbeatAt = now()
    if (a.mortyModel) st.mortyModel = a.mortyModel
    if (a.maxIterations) st.maxIterations = Math.min(a.maxIterations, HARD_CAP_ITERATIONS)
    if (a.maxTimeMin) st.maxTimeMs = a.maxTimeMin * 60_000
    if (a.maxTokens !== undefined) st.maxTokens = a.maxTokens
    if (a.workerTimeoutSec) st.workerTimeoutMs = a.workerTimeoutSec * 1000
    if (a.completionPromise) st.completionPromise = a.completionPromise
    // Keep the furthest phase: artifacts can move the loop forward, but resuming
    // a loop that already reached refactor must not drag it back to implement.
    st.phase = PHASES[Math.max(PHASES.indexOf(st.phase), PHASES.indexOf(inferPhase(st)))]
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
    const idleMin = Math.round((now() - (st.heartbeatAt ?? st.updatedAt)) / 60000)
    const stale = st.active && now() - (st.heartbeatAt ?? st.updatedAt) > STALE_MS
    const tickets = ticketList(st)
    const done = tickets.filter((t) => t.status === "done").length
    const next = nextTicket(st)
    const burn = Object.entries(st.phaseTokens ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
    return [
      `Session: ${st.id} (${st.active ? (stale ? `ACTIVE · STALE ${idleMin}m` : "ACTIVE") : `stopped: ${st.stopReason ?? "not started"}`})`,
      `Dir: ${relDir(st)}`,
      `Phase: ${st.phase} · iteration ${st.iteration}/${st.maxIterations} · ${mins}/${Math.round(st.maxTimeMs / 60000)} min`,
      `Tokens: ${budgetText(st)}${st.lastTurnTokens ? ` · last turn +${fmtNum(st.lastTurnTokens)}` : ""}${st.mortyTokens ? ` · Morty ${fmtNum(st.mortyTokens)}` : ""}`,
      `Left: ${st.maxTokens ? `${fmtNum(Math.max(0, st.maxTokens - tokensUsed(st)))} left` : "no cap"}`,
      ...(burn.length ? [`Burn: ${burn.map(([p, n]) => `${p} ${fmtNum(n)}`).join(" · ")}`] : []),
      `Tickets: ${done}/${tickets.length} done${next ? ` · next ${next.replace(/\.md$/, "")}` : tickets.length ? " · all done" : ""}`,
      `Jar: ${readJar().length} queued`,
      `Artifacts: prd ${fs.existsSync(path.join(dirOf(st), "prd.md")) ? "yes" : "no"} · tickets ${countFiles(path.join(dirOf(st), "tickets"))} · research ${countFiles(path.join(dirOf(st), "research"))} · plans ${countFiles(path.join(dirOf(st), "plans"))}`,
      `Promise: ${st.completionPromise}`,
      `Task: ${st.task}`,
    ].join("\n")
  }

  function prdExcerpt(st: LoopState): string {
    try {
      const p = path.join(dirOf(st), "prd.md")
      if (!fs.existsSync(p)) return ""
      const text = fs.readFileSync(p, "utf8").split("\n").slice(0, PRD_EXCERPT_LINES).join("\n").trim()
      return text ? `\n\nPRD excerpt (${relDir(st)}/prd.md):\n${text.slice(0, 3000)}` : ""
    } catch { return "" }
  }

  function compactionContext(sessionID: string): string | undefined {
    const st = findActive(sessionID)
    if (!st) return undefined
    return `## Pickle Rick loop (must survive compaction)\nTask: ${st.task}\nSession dir: ${relDir(st)} (prd.md, tickets/, research/, plans/)\nPhase: ${st.phase}, iteration ${st.iteration}/${st.maxIterations}\nTokens: ${budgetText(st)}\nEnd with <promise>${st.completionPromise}</promise> only when truly complete and verified.${prdExcerpt(st)}`
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

  function jarList(): string {
    const jar = readJar()
    if (!jar.length) return "🥒 The Jar is empty."
    const lines = jar.map((it, i) => `${i + 1}. ${it.task} (${it.id})`)
    return [`🥒 Pickle Jar — ${jar.length} queued:`, ...lines].join("\n")
  }

  function listSessions(): string {
    const all = loadAll()
    if (!all.length) return "🥒 No Pickle Rick sessions in this project yet."
    return [`🥒 ${all.length} session(s):`, ...all.map((s) =>
      `• ${s.id} — ${s.active ? "ACTIVE" : s.stopReason ?? "idle"} · ${s.phase} · ${fmtNum(tokensUsed(s))} tokens · ${s.task.slice(0, 60)}`,
    )].join("\n")
  }

  // Prune only finished sessions older than keepDays; a live loop is never deleted.
  function cleanSessions(keepDays = 7): string {
    const cutoff = now() - Math.max(1, keepDays) * 86_400_000
    let removed = 0
    let kept = 0
    for (const s of loadAll()) {
      if (s.active || s.updatedAt > cutoff) { kept++; continue }
      try { fs.rmSync(dirOf(s), { recursive: true, force: true }); removed++ } catch { kept++ }
    }
    return removed
      ? `🧹 Removed ${removed} finished session(s) older than ${keepDays} day(s); kept ${kept}.`
      : `🥒 Nothing to clean: ${kept} session(s) kept.`
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
    // Resolve which ticket this worker gets. Empty means "next open ticket"; a
    // ticket already marked done is refused so the loop never pays twice.
    const tickets = st ? ticketList(st) : []
    let file = ticket.trim()
    if (!file || /^next$/i.test(file)) file = st ? (nextTicket(st) ?? "") : ""
    else if (st) {
      const hit = findTicket(st, file)
      if (!hit) {
        const names = tickets.map((t) => t.file.replace(/\.md$/, "")).join(", ") || "none"
        return `🥒 No ticket "${ticket}". Available: ${names}.`
      }
      file = hit
    }
    if (st && file && ticketStatus(file, st) === "done") {
      return `🥒 Ticket ${file} is already done. Next open: ${nextTicket(st) ?? "none"}.`
    }
    if (!file) return `🥒 No ticket to send. Create files in tickets/ first, or pass one explicitly.`
    const label = file.replace(/\.md$/, "")
    // Morty runs in a child session with its own context. Inherit the parent's
    // model (and variant) so the worker does not fall back to the default model;
    // the agent stays "morty" so the worker prompt/persona is the Morty one.
    let parentModel: any
    try {
      const pmsgs: any[] = unwrap(await client.session.messages({ path: { id: parentID } })) ?? []
      parentModel = [...pmsgs].reverse().find((m) => m.info?.role === "assistant" && m.info?.model)?.info?.model
    } catch {}
    const model = st?.mortyModel ?? parentModel
    const child = unwrap(
      await client.session.create({ body: { parentID, title: `🥒 Morty: ${label}`, agent: "morty", model } }),
    )
    if (!child?.id) return `Morty failed to spawn for ${label}.`
    const childUsage = async (id: string): Promise<TokenTotals | undefined> => {
      try { return tokenTotals(unwrap(await client.session.messages({ path: { id } })) ?? []) } catch { return undefined }
    }
    const account = async (id: string) => {
      const usage = await childUsage(id)
      if (st && usage) {
        if (usage.total) st.mortyTokens = (st.mortyTokens ?? 0) + usage.total
        if (usage.cost) st.mortyCost = (st.mortyCost ?? 0) + usage.cost
        save(st)
      }
      return usage
    }
    const where = st ? relDir(st) : ".pickle-rick/sessions/<session>"
    const text = [
      `You are Morty, a worker. Implement exactly ONE ticket: ${label}`,
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
        return `Morty timed out on ${label} after ${Math.round(timeoutMs / 1000)}s and was aborted (child session ${child.id}, ${usage?.total ? `${fmtNum(usage.total)} tokens` : "usage unknown"}). Check the files, then retry or finish it yourself.`
      }
      const data = unwrap(r)
      const out = (data?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").trim()
      const cost = usage?.total ? `\n(child used ${fmtNum(usage.total)} tokens · ${fmtNum(usage.cacheRead)} cache read${usage.cost ? ` · ${fmtCost(usage.cost)}` : ""})` : ""
      return `Morty finished ${label} (child session ${child.id}):\n${out || "(no report)"}${cost}`
    } catch (e: any) {
      return `Morty crashed on ${label}: ${e?.message ?? e}`
    } finally {
      clearTimeout(timer)
    }
  }

  return { handleEvent, startFromRaw, stop, initPrd, setPhase, status, compactionContext, jarAdd, jarList, jarOpen, listSessions, cleanSessions, sendToMorty, buildPrompt }
}
