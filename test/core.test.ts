import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createEngine, parseArgs, tokenize, extractPromise } from "../.opencode/pickle-rick/core.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SID = "S1"

// A tiny fake of the opencode SDK client: each session.prompt() appends a user message,
// plays the next scripted assistant reply, and fires session.idle like opencode would.
function setup(script: string[], opts: { now?: () => number; hangChild?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pickle-"))
  const msgs: any[] = []
  const prompts: any[] = []
  const toasts: string[] = []
  const aborted: string[] = []
  let n = 0
  let engine: ReturnType<typeof createEngine>

  const playTurn = (assistantOverride?: any) => {
    const next = script[n] ?? "still working"
    n++
    msgs.push({
      info: { id: `a${n}`, role: "assistant", time: { created: 1, completed: 2 }, ...assistantOverride },
      parts: [{ type: "text", text: next }],
    })
    setImmediate(() => engine.handleEvent({ type: "session.idle", properties: { sessionID: SID } }))
  }

  const client = {
    app: { log: async () => true },
    tui: { showToast: async ({ body }: any) => { toasts.push(body.message); return true } },
    session: {
      messages: async () => ({ data: msgs }),
      prompt: async ({ path: p, body }: any) => {
        if (p.id !== SID) {
          // Morty child session
          if (opts.hangChild) return new Promise(() => {})
          return { data: { parts: [{ type: "text", text: "Ticket done. 3 tests pass." }] } }
        }
        prompts.push(body)
        msgs.push({ info: { id: `u${n}`, role: "user", agent: "build", model: { providerID: "p", modelID: "m" } }, parts: body.parts })
        playTurn()
        return { data: {} }
      },
      create: async ({ body }: any) => ({ data: { id: "child-1", ...body } }),
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
  return { dir, engine, prompts, toasts, aborted, msgs, start, idle, playTurn }
}

const states = (dir: string) =>
  fs.readdirSync(path.join(dir, ".pickle-rick/sessions")).map((d) => JSON.parse(fs.readFileSync(path.join(dir, ".pickle-rick/sessions", d, "state.json"), "utf8")))

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

test("Morty returns the worker report", async () => {
  const t = setup([])
  t.engine.startFromRaw(SID, `"x"`)
  const out = await t.engine.sendToMorty(SID, "001-thing", "run npm test")
  assert.match(out, /Ticket done/)
})

test("Morty is aborted on timeout", async () => {
  const t = setup([], { hangChild: true })
  t.engine.startFromRaw(SID, `"x" --worker-timeout 1`)
  const out = await t.engine.sendToMorty(SID, "001-thing", "go")
  assert.match(out, /timed out/)
  assert.deepEqual(t.aborted, ["child-1"])
})
