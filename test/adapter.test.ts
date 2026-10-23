import test from "node:test"
import assert from "node:assert/strict"
import { createV1Client, mapMessage, terminalTurn } from "../.opencode/pickle-rick/adapter.ts"

// A fake of the v2 plugin context: records calls and replays a scripted list of
// session context snapshots, so polling can be tested without timers.
function fakeCtx(seq: any[][] = [[]], opts: { onCreate?: (input: any) => any } = {}) {
  const calls = { prompts: [] as any[], created: [] as any[], interrupts: [] as string[], agents: [] as any[], models: [] as any[] }
  let i = 0
  const ctx = {
    session: {
      prompt: async (input: any) => { calls.prompts.push(input); return {} },
      context: async () => seq[Math.min(i++, seq.length - 1)],
      create: async (input: any) => {
        calls.created.push(input)
        return opts.onCreate ? opts.onCreate(input) : { id: "child-1", ...input }
      },
      interrupt: async ({ sessionID }: any) => { calls.interrupts.push(sessionID) },
      switchAgent: async (input: any) => { calls.agents.push(input) },
      switchModel: async (input: any) => { calls.models.push(input) },
    },
  }
  return { ctx, calls }
}

const assistant = (over: any = {}) => ({
  id: "a1", type: "assistant", finish: "stop", time: { completed: 1 },
  content: [{ type: "text", text: "done" }], ...over,
})

test("mapMessage flattens v2 messages into the v1 shape", () => {
  const m = mapMessage(assistant({ tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.002 }))
  assert.equal(m.info.role, "assistant")
  assert.equal(m.parts[0].text, "done")
  assert.equal(m.info.cost, 0.002)
  assert.equal(mapMessage({ id: "u1", type: "user", text: "hello" }).info.role, "user")
  assert.equal(mapMessage({ id: "e1", type: "assistant", error: { type: "MessageAbortedError", message: "x" } }).info.error.name, "MessageAbortedError")
})

test("terminalTurn ignores tool-call-only turns", () => {
  assert.equal(terminalTurn({ finish: "tool-calls" }), false)
  assert.equal(terminalTurn({ finish: "stop" }), true)
  assert.equal(terminalTurn({ error: { name: "MessageAbortedError" } }), true)
  assert.equal(terminalTurn({ content: [{ type: "text", text: "hi" }] }), true)
})

test("prompt waits for a terminal turn, skipping tool calls", async () => {
  const toolCall = assistant({ id: "a2", finish: "tool-calls", content: [] })
  const final = assistant({ id: "a3", content: [{ type: "text", text: "final answer" }] })
  const { ctx, calls } = fakeCtx([[], [toolCall], [toolCall, final]])
  const client = createV1Client(ctx, { sleep: async () => {}, intervalMs: 0 })
  const res = await client.session.prompt({ path: { id: "S" }, body: { parts: [{ type: "text", text: "go" }] } })
  assert.equal(calls.prompts[0].text, "go")
  assert.equal(res.data.info.finish, "stop")
  assert.equal(res.data.parts[0].text, "final answer")
})

test("prompt resolves soft when the poll cap is hit", async () => {
  const { ctx } = fakeCtx([[]])
  const client = createV1Client(ctx, { sleep: async () => {}, capMs: 0 })
  const res = await client.session.prompt({ path: { id: "S" }, body: { parts: [{ type: "text", text: "go" }] } })
  assert.deepEqual(res.data, { info: {}, parts: [] })
})

test("prompt switches agent and model when the body carries them", async () => {
  const { ctx, calls } = fakeCtx([[], [assistant()]])
  const client = createV1Client(ctx, { sleep: async () => {} })
  await client.session.prompt({
    path: { id: "S" },
    body: { parts: [{ type: "text", text: "go" }], agent: "build", model: { providerID: "p", id: "m" } },
  })
  assert.deepEqual(calls.agents[0], { sessionID: "S", agent: "build" })
  assert.deepEqual(calls.models[0], { sessionID: "S", model: { providerID: "p", id: "m" } })
})

test("messages maps the whole context", async () => {
  const { ctx } = fakeCtx([[{ id: "u", type: "user", text: "hi" }, assistant()]])
  const client = createV1Client(ctx, { sleep: async () => {} })
  const res = await client.session.messages({ path: { id: "S" } })
  assert.equal(res.data.length, 2)
  assert.equal(res.data[1].info.role, "assistant")
})

test("create forwards agent and model, then switches as a fallback", async () => {
  const { ctx, calls } = fakeCtx([])
  const client = createV1Client(ctx, { sleep: async () => {} })
  const model = { providerID: "p", id: "m", variant: "high" }
  const res = await client.session.create({ body: { parentID: "P", title: "t", agent: "morty", model } })
  assert.equal(res.data.id, "child-1")
  assert.deepEqual(calls.created[0], { parentID: "P", title: "t", agent: "morty", model })
  assert.deepEqual(calls.models[0], { sessionID: "child-1", model })
})

test("abort becomes interrupt", async () => {
  const { ctx, calls } = fakeCtx([])
  const client = createV1Client(ctx, { sleep: async () => {} })
  await client.session.abort({ path: { id: "S" } })
  assert.deepEqual(calls.interrupts, ["S"])
})
