import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createEngine, parseArgs, parseModelRef, parseTokenLimit, tokenTotals, tokenize, extractPromise } from "../.opencode/pickle-rick/core.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "S1"

// A tiny fake of the opencode SDK client: each session.prompt() appends a user message,
// plays the next scripted assistant reply, and fires session.idle like opencode would.
function setup(script: string[], opts: { now?: () => number; hangChild?: boolean; turn?: any } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pickle-"))
  const msgs: any[] = []
  const childMsgs: any[] = []
  const prompts: any[] = []
  const toasts: string[] = []
  const aborted: string[] = []
  const created: any[] = []
  let n = 0
  let engine: ReturnType<typeof createEngine>

  const playTurn = (assistantOverride?: any) => {
    const next = script[n] ?? "still working"
    n++
    msgs.push({
      info: { id: `a${n}`, role: "assistant", time: { created: 1, completed: 2 }, ...(opts.turn ?? {}), ...assistantOverride },
      parts: [{ type: "text", text: next }],
    })
    setImmediate(() => engine.handleEvent({ type: "session.idle", properties: { sessionID: SID } }))
  }

  const client = {
    app: { log: async () => true },
    tui: { showToast: async ({ body }: any) => { toasts.push(body.message); return true } },
    session: {
      messages: async ({ path: p }: any) => ({ data: p.id === SID ? msgs : childMsgs }),
      prompt: async ({ path: p, body }: any) => {
        if (p.id !== SID) {
          // Morty child session
          if (opts.hangChild) return new Promise(() => {})
          childMsgs.push({
            info: {
              id: "c1",
              role: "assistant",
              time: { created: 1, completed: 2 },
              tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: "Ticket done. 3 tests pass." }],
          })
          return { data: { parts: [{ type: "text", text: "Ticket done. 3 tests pass." }] } }
        }
        prompts.push(body)
        msgs.push({ info: { id: `u${n}`, role: "user", agent: "build", model: { providerID: "p", modelID: "m" } }, parts: body.parts })
        playTurn()
        return { data: {} }
      },
      create: async ({ body }: any) => { created.push(body); return { data: { id: "child-1", ...body } } },
      abort: async ({ path: p }: any) => { aborted.push(p.id); return { data: true } },
    },
  }
  engine = createEngine({ client, directory: dir, now: opts.now })
  const start = async (raw: string) => {
    const out = engine.startFromRaw(SID, raw)
    msgs.push({ info: { id: "u-first", role: "user", agent: "build", model: { providerID: "p", modelID: "m" } }, parts: [] })
    playTurn() // the turn in which the agent called pickle_start
    await sleep(60)
    return out
  }
  const idle = () => engine.handleEvent({ type: "session.idle", properties: { sessionID: SID } })
  return { dir, engine, prompts, toasts, aborted, created, msgs, start, idle, playTurn }
}

const states = (dir: string) =>
  fs.readdirSync(path.join(dir, ".pickle-rick/sessions")).map((d) => JSON.parse(fs.readFileSync(path.join(dir, ".pickle-rick/sessions", d, "state.json"), "utf8")))

// Drop a ticket into the newest session so Morty has something to claim.
const writeTicket = (dir: string, id: string, status = "open") => {
  const st = states(dir)[0]
  const p = path.join(dir, ".pickle-rick/sessions", st.id, "tickets", `${id}.md`)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, `# ${id}\nStatus: ${status}`)
}

test("tokenize keeps apostrophes and quoted phrases", () => {
  assert.deepEqual(tokenize(`fix the user's login --name "my slug"`), ["fix", "the", "user's", "login", "--name", "my slug"])
})

test("parseArgs reads flags, task and resume", () => {
  const a = parseArgs(`"Refactor the auth module" --max-iterations 8 --max-time=30 --completion-promise "SHIPPED IT"`)
  assert.equal(a.task, "Refactor the auth module")
  assert.equal(a.maxIterations, 8)
  assert.equal(a.maxTimeMin, 30)
  assert.equal(a.completionPromise, "SHIPPED IT")
  assert.deepEqual(parseArgs("--resume").resume, true)
  assert.equal(parseArgs("--resume .pickle-rick/sessions/x").resumePath, ".pickle-rick/sessions/x")
  assert.equal(parseArgs("t --max-iterations nope").errors.length, 1)
})

test("extractPromise takes the last tag", () => {
  assert.equal(extractPromise("a <promise>X</promise> b <promise> DONE </promise>"), "DONE")
  assert.equal(extractPromise("nothing"), null)
})

test("parseTokenLimit reads k/m suffixes and off", () => {
  assert.equal(parseTokenLimit("500k"), 500_000)
  assert.equal(parseTokenLimit("1.5m"), 1_500_000)
  assert.equal(parseTokenLimit("200000"), 200_000)
  assert.equal(parseTokenLimit("off"), 0)
  assert.equal(parseTokenLimit("0"), 0)
  assert.equal(parseTokenLimit("nope"), undefined)
  assert.equal(parseArgs(`"x" --max-tokens 500k`).maxTokens, 500_000)
  assert.equal(parseArgs(`"x" --max-tokens=off`).maxTokens, 0)
  assert.equal(parseArgs(`"x" --max-tokens nope`).errors.length, 1)
})

test("tokenTotals sums assistant usage since the loop started", () => {
  const msgs = [
    { info: { role: "assistant", time: { created: 100 }, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 7, write: 2 } } } },
    { info: { role: "user", time: { created: 150 } } },
    { info: { role: "assistant", time: { created: 200 }, tokens: { input: 20, output: 8, reasoning: 0, cache: { read: 0, write: 0 } } } },
  ]
  assert.deepEqual(tokenTotals(msgs), {
    input: 30, output: 13, reasoning: 1, cacheRead: 7, cacheWrite: 2, total: 44, cost: 0,
  })
  assert.equal(tokenTotals(msgs, 150).total, 28) // only the second turn
})

test("max-tokens stops the loop before the next iteration", async () => {
  const t = setup([], {
    turn: {
      time: { created: 9e15, completed: 9e15 },
      tokens: { input: 900, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })
  await t.start(`"x" --max-iterations 10 --max-tokens 1k`)
  await sleep(60)
  const [st] = states(t.dir)
  assert.equal(st.stopReason, "max-tokens")
  assert.equal(st.tokensUsed.total, 1100)
  assert.equal(t.prompts.length, 0) // the over-budget turn was never re-prompted
})

test("loop keeps re-prompting until the completion promise", async () => {
  const t = setup(["phase 1 done", "phase 2 done", "all good <promise>DONE</promise>"])
  await t.start(`"Build thing" --max-iterations 10`)
  await sleep(100)
  assert.equal(t.prompts.length, 2)
  assert.match(t.prompts[0].parts[0].text, /iteration 2\/10/)
  assert.equal(t.prompts[0].agent, "build") // agent preserved
  assert.deepEqual(t.prompts[0].model, { providerID: "p", modelID: "m" }) // model preserved
  const [st] = states(t.dir)
  assert.equal(st.active, false)
  assert.equal(st.stopReason, "completed")
})

test("max-iterations stops the loop", async () => {
  const t = setup([])
  await t.start(`"Never ends" --max-iterations 2`)
  await sleep(100)
  assert.equal(t.prompts.length, 1)
  assert.equal(states(t.dir)[0].stopReason, "max-iterations")
})

test("a wrong promise text does not stop the loop", async () => {
  const t = setup(["<promise>NOPE</promise>", "<promise>DONE</promise>"])
  await t.start(`"x" --max-iterations 5`)
  await sleep(100)
  assert.equal(states(t.dir)[0].stopReason, "completed")
  assert.equal(t.prompts.length, 1)
})

test("duplicate idle events do not double-prompt", async () => {
  const t = setup(["a", "b", "<promise>DONE</promise>"])
  await t.start(`"x" --max-iterations 5`)
  await t.idle()
  await t.idle()
  await sleep(100)
  assert.equal(t.prompts.length, 2) // exactly one prompt per finished turn
})

test("aborted turn is treated as interrupted", async () => {
  const t = setup(["x"])
  t.engine.startFromRaw(SID, `"x"`)
  t.msgs.push({ info: { id: "ab", role: "assistant", error: { name: "MessageAbortedError" } }, parts: [] })
  await t.idle()
  assert.equal(states(t.dir)[0].stopReason, "interrupted")
  assert.equal(t.prompts.length, 0)
})

test("max-time stops the loop", async () => {
  let clock = 0
  const t = setup([], { now: () => clock })
  t.engine.startFromRaw(SID, `"x" --max-time 1 --max-iterations 50`)
  clock = 61_000
  t.playTurn()
  await sleep(60)
  assert.equal(states(t.dir)[0].stopReason, "max-time")
})

test("/eat-pickle cancels the loop", async () => {
  const t = setup([])
  t.engine.startFromRaw(SID, `"x"`)
  assert.match(await t.engine.stop(SID), /cancelled/)
  t.playTurn()
  await sleep(60)
  assert.equal(t.prompts.length, 0)
})

test("PRD session then --resume infers the breakdown phase", async () => {
  const t = setup([])
  const msg = t.engine.initPrd(`"Dark mode toggle"`)
  const rel = /Session created: (\S+)\//.exec(msg)![1]
  fs.writeFileSync(path.join(t.dir, rel, "prd.md"), "# PRD")
  const out = t.engine.startFromRaw(SID, "--resume")
  assert.match(out, /Starting phase: breakdown/)
  assert.equal(states(t.dir)[0].active, true)
})

test("jar runs queued tasks back to back", async () => {
  const t = setup(["<promise>DONE</promise>", "<promise>DONE</promise>"])
  t.engine.jarAdd("first task")
  t.engine.jarAdd("second task")
  assert.match(t.engine.jarOpen(SID), /first task/)
  t.playTurn() // first loop completes
  await sleep(150)
  assert.equal(t.prompts.length, 1)
  assert.match(t.prompts[0].parts[0].text, /second task/)
  await sleep(100)
  assert.ok(t.toasts.some((m) => m.includes("Jar is empty")))
})

test("Morty returns the worker report and inherits the parent model", async () => {
  const t = setup([])
  t.engine.startFromRaw(SID, `"x"`)
  writeTicket(t.dir, "001-thing")
  t.msgs.push({
    info: { id: "am", role: "assistant", model: { providerID: "p", id: "m", variant: "high" }, time: { created: 1, completed: 2 } },
    parts: [],
  })
  const out = await t.engine.sendToMorty(SID, "001-thing", "run npm test")
  assert.match(out, /Ticket done/)
  assert.equal(t.created[0].agent, "morty")
  assert.deepEqual(t.created[0].model, { providerID: "p", id: "m", variant: "high" })
  assert.match(out, /child used 120 tokens/)
  assert.equal(states(t.dir)[0].mortyTokens, 120)
})

test("Morty is aborted on timeout", async () => {
  const t = setup([], { hangChild: true })
  t.engine.startFromRaw(SID, `"x" --worker-timeout 1`)
  writeTicket(t.dir, "001-thing")
  const out = await t.engine.sendToMorty(SID, "001-thing", "go")
  assert.match(out, /timed out/)
  assert.deepEqual(t.aborted, ["child-1"])
})

test("status reports remaining budget, Jar queue and artifacts", () => {
  const t = setup([])
  t.engine.initPrd("status demo")
  const st = states(t.dir)[0]
  fs.writeFileSync(path.join(t.dir, ".pickle-rick/sessions", st.id, "tickets", "001-a.md"), "# a")
  t.engine.jarAdd("queued")
  const out = t.engine.status(SID)
  assert.match(out, /Left: 2,000,000 left/)
  assert.match(out, /Jar: 1 queued/)
  assert.match(out, /Artifacts: prd no · tickets 1 · research 0 · plans 0/)
})

test("resume keeps the recorded phase", () => {
  const t = setup([])
  t.engine.initPrd("resume demo")
  const st = states(t.dir)[0]
  const dir = path.join(t.dir, ".pickle-rick/sessions", st.id)
  for (const [f, body] of [["prd.md", "# p"], ["tickets/001-a.md", "# a"], ["research/r.md", "# r"], ["plans/p.md", "# p"]] as const) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), body)
  }
  st.phase = "refactor"
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(st, null, 2))
  t.engine.startFromRaw(SID, "--resume")
  assert.equal(states(t.dir)[0].phase, "refactor")
})

test("parseModelRef splits provider/model and keeps variants", () => {
  assert.deepEqual(parseModelRef("opencode/glm-5.3-flash-free"), { providerID: "opencode", id: "glm-5.3-flash-free" })
  assert.deepEqual(parseModelRef("p/m#high"), { providerID: "p", id: "m", variant: "high" })
  assert.equal(parseModelRef("nope"), undefined)
  const a = parseArgs(`"x" --force --allow-dirty --morty-model opencode/glm-5.3`)
  assert.equal(a.task, "x")
  assert.equal(a.force, true)
  assert.equal(a.allowDirty, true)
  assert.equal(a.mortyModel?.id, "glm-5.3")
})

test("a second start is refused until --force", () => {
  const t = setup([])
  assert.match(t.engine.startFromRaw(SID, `"x" --max-iterations 50`), /Loop armed/)
  assert.match(t.engine.startFromRaw(SID, `"y" --max-iterations 50`), /already running/)
  assert.match(t.engine.startFromRaw(SID, `"y" --max-iterations 50 --force`), /Loop armed/)
})

test("warns once when the token budget crosses 80%", async () => {
  const t = setup([], {
    turn: {
      time: { created: 9e15, completed: 9e15 },
      tokens: { input: 1600, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })
  await t.start(`"x" --max-iterations 10 --max-tokens 2k`)
  await t.idle()
  const warnings = t.toasts.filter((m) => m.includes("tokens used"))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /85%/)
})

test("status shows ticket progress, cost and phase burn", async () => {
  const t = setup([], {
    turn: {
      time: { created: 9e15, completed: 9e15 },
      cost: 0.01,
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })
  await t.start(`"x" --max-iterations 10`)
  const st = states(t.dir)[0]
  const tickets = path.join(t.dir, ".pickle-rick/sessions", st.id, "tickets")
  fs.writeFileSync(path.join(tickets, "001-a.md"), "# a\nStatus: done")
  fs.writeFileSync(path.join(tickets, "002-b.md"), "# b\nStatus: open")
  const out = t.engine.status(SID)
  assert.match(out, /Tickets: 1\/2 done · next 002-b/)
  assert.match(out, /\$0\.\d{4}/)
  assert.match(out, /Burn: prd/)
})

test("Morty picks the next open ticket and refuses a done one", async () => {
  const t = setup([])
  t.engine.startFromRaw(SID, `"x" --max-iterations 10`)
  const st = states(t.dir)[0]
  const tickets = path.join(t.dir, ".pickle-rick/sessions", st.id, "tickets")
  fs.writeFileSync(path.join(tickets, "001-a.md"), "# a\nStatus: done")
  fs.writeFileSync(path.join(tickets, "002-b.md"), "# b\nStatus: open")
  assert.match(await t.engine.sendToMorty(SID, "001-a", "go"), /already done/)
  assert.equal(t.created.length, 0)
  assert.match(await t.engine.sendToMorty(SID, "", "go"), /Ticket done/)
  assert.match(t.created[0].title, /002-b/)
})

test("--morty-model overrides the inherited parent model", async () => {
  const t = setup([])
  t.engine.startFromRaw(SID, `"x" --max-iterations 10 --morty-model opencode/cheap#high`)
  writeTicket(t.dir, "001-any")
  await t.engine.sendToMorty(SID, "001-any", "go")
  assert.deepEqual(t.created[0].model, { providerID: "opencode", id: "cheap", variant: "high" })
})

test("compaction carries a PRD excerpt", () => {
  const t = setup([])
  t.engine.initPrd("compaction demo")
  const st = states(t.dir)[0]
  fs.writeFileSync(path.join(t.dir, ".pickle-rick/sessions", st.id, "prd.md"), "# PRD\nUniqueRequirementLine")
  t.engine.startFromRaw(SID, "--resume")
  assert.match(t.engine.compactionContext(SID) ?? "", /UniqueRequirementLine/)
})

test("jar list shows the queue in order", () => {
  const t = setup([])
  t.engine.jarAdd("first")
  t.engine.jarAdd("second")
  const out = t.engine.jarList()
  assert.match(out, /1\. first/)
  assert.match(out, /2\. second/)
  assert.match(setup([]).engine.jarList(), /Jar is empty/)
})

test("clean removes only old finished sessions", () => {
  const t = setup([])
  t.engine.initPrd("old one")
  t.engine.initPrd("fresh one")
  const all = states(t.dir)
  const old = all.find((s) => s.task === "old one")!
  old.updatedAt = Date.now() - 10 * 86_400_000
  fs.writeFileSync(path.join(t.dir, ".pickle-rick/sessions", old.id, "state.json"), JSON.stringify(old, null, 2))
  assert.match(t.engine.cleanSessions(7), /Removed 1/)
  assert.equal(states(t.dir).length, 1)
  assert.ok(!fs.existsSync(path.join(t.dir, ".pickle-rick/sessions", old.id)))
})

test("status flags a stale active loop", () => {
  let clock = 0
  const t = setup([], { now: () => clock })
  t.engine.startFromRaw(SID, `"x" --max-iterations 50`)
  clock = 1_200_000
  assert.match(t.engine.status(SID), /STALE 20m/)
})

