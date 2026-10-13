/**
 * `/persona spawn|compact` regression coverage.
 *
 * `spawn` hands a signal to the subagent service, which calls
 * `signal.throwIfAborted()` on it. `new AbortSignal()` — the shape this code
 * used to carry — is a TypeError ("Illegal constructor"), so every popup pick of
 * 派生 died on the Host with `command/done { kind: "error", text: "Illegal
 * constructor" }`. These tests drive the real handler and assert the signal that
 * actually reaches `ctx.subagents`.
 *
 * `compact` is the other half of the contract, and it is the opposite shape:
 * ONE in-process `ctx.llm.stream()` call, no child session, no subagent, no
 * binding ledger row. It used to run as a one-shot structured subagent, which
 * polluted the session list, dragged the whole persona machinery (gate, closing
 * reflection) into a maintenance call, and left the child's closing turn with
 * every tool denied by the structured-run guard. These tests pin the in-process
 * shape: the audit answers through `structured_output`, and the tree is the only
 * thing it can change.
 *
 * They also pin the OTHER half of the spawn contract: every path that equips a
 * child session must register that child in the `.persona/.bindings/` ledger.
 * The ledger is what the `/personas` picker badges and what re-equips a session
 * after a restart, so an unregistered child is equipped-but-invisible.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { registerCommands } from '../lib/commands.js'
import { libraryRoot } from '../lib/persona.js'
import { pendingContinuable } from '../lib/provider.js'

/** A workspace holding one usable persona archive. */
function workspace(name = 'deepseek') {
  const root = mkdtempSync(join(tmpdir(), 'persona-cmd-'))
  mkdirSync(join(root, '.persona', name), { recursive: true })
  writeFileSync(
    join(root, '.persona', name, 'PERSONA.md'),
    `---\nname: ${name}\ndescription: 大肥鱼\n---\n\n## Layer 1 · Core Self\n\n- **identity**: 鲸萝\n`,
    'utf8',
  )
  return root
}

/** Write one memory node with frontmatter, the way `memory_create` would. */
function node(root, name, uri, { priority = 3, disclosure = '', triggers = [], body = '' } = {}) {
  const file = join(root, '.persona', name, 'memory', `${uri.replace('memory://', '')}.md`)
  mkdirSync(dirname(file), { recursive: true })
  const trig = triggers.length ? `triggers:\n${triggers.map(t => `  - ${t}`).join('\n')}\n` : ''
  writeFileSync(file, `---\ntitle: ${uri.split('/').pop()}\npriority: ${priority}\ndisclosure: "${disclosure}"\n${trig}---\n\n${body}\n`, 'utf8')
}

/** Give a workspace persona a memory tree and the index that projects it. */
function withMemory(root, name = 'deepseek') {
  writeFileSync(join(root, '.persona', name, 'MEMORY.md'), `# Memory Index — ${name}\n\n## Boot URIs\nmemory://core/identity\n\n## Index\n`, 'utf8')
  node(root, name, 'memory://core/identity', { priority: 1, disclosure: 'boot', body: '我是鲸萝。' })
  node(root, name, 'memory://core/user/no_detours', { priority: 2, disclosure: '每次组织回复时记得：结论先行', triggers: ['绕弯'], body: '主人受不了绕弯子，回答先给结论。' })
  node(root, name, 'memory://core/user/think_before_speaking', { priority: 1, disclosure: '每次组织回复时：先想清楚再给结论', triggers: ['结论'], body: '主人要我深入思考。' })
  return root
}

const readMemory = (root, uri, name = 'deepseek') =>
  readFileSync(join(root, '.persona', name, 'memory', `${uri.replace('memory://', '')}.md`), 'utf8')

/** The binding row a session id was registered under, or undefined. */
function bindingOf(root, sessionId) {
  const file = join(libraryRoot(root), '.bindings', `${sessionId}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}

/**
 * Minimal live agent + agent ctx for the `use` path, which really does equip:
 * `equipAgent` registers prompt sections, tools and listeners on `agent.ctx`,
 * so the recording shape has to be the one it reaches for.
 * @param root - workspace root the handler resolves its cwd to.
 * @param ids - `agentId`/`sessionId`; a subagent child has one bare uuid for both.
 */
function fakeAgent(root, { agentId = 'agent-1', sessionId = 'session-1' } = {}) {
  const handlers = {}
  const registered = new Map()
  const sections = []
  return {
    id: agentId,
    // The compaction call resolves its route from here when nothing is routed
    // yet; `session.requestHeader` is absent, exactly like a fresh session.
    options: { provider: 'mock', model: 'mock-1' },
    session: {
      header: { id: sessionId, cwd: root },
      id: sessionId,
      deriveMessages: () => [],
      snapshotEvents: () => [],
    },
    inject: () => {},
    followup: () => {},
    ctx: {
      handlers,
      registered,
      sections,
      effect: () => () => {},
      systemPrompt: {
        section: (s) => { sections.push(s); return () => { const i = sections.indexOf(s); if (i >= 0) sections.splice(i, 1) } },
        getSectionOrder: () => 0,
      },
      on: (name, fn) => { (handlers[name] ??= []).push(fn); return () => {} },
      tools: { register: (def) => { registered.set(def.name, def); return () => { registered.delete(def.name) } } },
      logger: { warn: () => {} },
    },
  }
}

/**
 * One fake `ctx.llm.stream()` response, as chunks.
 *
 * `plan` streams a `structured_output` tool call whose arguments arrive split
 * across two deltas (the real wire shape, and the reason the fold has to
 * accumulate rather than read one block); `text` streams plain text with no tool
 * call, which is what an adapter that ignores `tools` on a one-shot request
 * looks like; `finish` overrides the terminal reason; `throw` fails the call.
 * @param response - one response descriptor.
 */
async function* llmStream(response = {}) {
  if (response.throw !== undefined) throw new Error(response.throw)
  if (response.plan !== undefined) {
    const args = JSON.stringify(response.plan)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'structured_output', argumentsDelta: args.slice(0, 6) }
    yield { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: args.slice(6) }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'structured_output', arguments: args } }
  } else if (response.text !== undefined) {
    yield { type: 'text-delta', index: 0, text: response.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response.text } }
  }
  yield { type: 'finish', reason: response.finish ?? { kind: 'stop' } }
}

/**
 * Register the commands against a recording ctx and return a runner.
 * @param root - workspace root the handler resolves its cwd to.
 * @param ids - `agentId`/`sessionId` identity for the agent under test.
 * @param options - `response` is the single fake LLM response; `responses` is a
 *   per-call list (the last one repeats) for retry coverage.
 */
function harness(root, ids = {}, options = {}) {
  const calls = { startContinuable: [], start: [], llm: [] }
  const command = { handler: undefined }
  const responses = options.responses ?? [options.response ?? { plan: { ops: [] } }]
  const ctx = {
    commands: { register: (spec) => { command.handler = spec.handler } },
    subagents: {
      async startContinuable(spec) {
        calls.startContinuable.push(spec)
        return { childId: spec.childId, messageId: 'msg-1' }
      },
      async start(_provider, spec) {
        calls.start.push(spec)
        return { id: 'child-compact-1', result: Promise.resolve({ stopReason: 'completed' }) }
      },
    },
    llm: {
      stream(spec) {
        calls.llm.push(spec)
        return llmStream(responses[Math.min(calls.llm.length - 1, responses.length - 1)])
      },
    },
  }
  const cfg = { libraryDir: '.persona', providerName: 'persona', ...(options.cfg ?? {}) }
  const agent = fakeAgent(root, ids)
  registerCommands(ctx, cfg, () => root)
  assert.equal(typeof command.handler, 'function', '/persona registers a handler')
  return { run: rawInput => command.handler({ agent, rawInput }), calls, agent, ctx }
}

/** Every signal the run handed to the subagent service must be live and real. */
function assertLiveSignal(signal) {
  assert.ok(signal instanceof AbortSignal, 'signal must be an AbortSignal instance')
  assert.equal(signal.aborted, false, 'signal must not be pre-aborted')
  // The exact call the subagent service makes; a `new AbortSignal()` shape would
  // already have thrown "Illegal constructor" before this point.
  signal.throwIfAborted()
}

test('spawn hands the subagent service a live AbortSignal', async () => {
  const { run, calls } = harness(workspace())
  const result = await run('spawn deepseek 打个招呼')

  assert.equal(result.kind, 'success', `spawn must succeed, got: ${JSON.stringify(result)}`)
  assert.equal(calls.startContinuable.length, 1)
  const spec = calls.startContinuable[0]
  assertLiveSignal(spec.signal)
  assert.equal(spec.provider, 'persona')
  assert.match(result.text, /Spawned persona agent "deepseek"/)
})

test('spawn with no task still passes a live AbortSignal', async () => {
  const { run, calls } = harness(workspace())
  const result = await run('spawn deepseek')

  assert.equal(result.kind, 'success', `spawn must succeed, got: ${JSON.stringify(result)}`)
  assertLiveSignal(calls.startContinuable[0].signal)
})

test('compact is one in-process llm call — no child session, no subagent', async () => {
  const { run, calls } = harness(workspace(), {}, { response: { plan: { ops: [] } } })
  const result = await run('compact deepseek')

  assert.equal(result.kind, 'success', `compact must succeed, got: ${JSON.stringify(result)}`)
  assert.equal(calls.llm.length, 1, 'the audit is ONE auxiliary call')
  assert.equal(calls.start.length, 0, 'compact must not create a subagent run')
  assert.equal(calls.startContinuable.length, 0, 'compact must not create a continuable child')
  assertLiveSignal(calls.llm[0].signal)
  assert.match(result.text, /no edits/)
})

test('compact asks for a plan and ships the whole tree in one user message', async () => {
  const root = withMemory(workspace())
  const { run, calls } = harness(root, {}, { response: { plan: { ops: [] } } })
  await run('compact deepseek')

  const spec = calls.llm[0]
  assert.equal(spec.tools.length, 1, 'exactly one tool: the structured answer')
  assert.equal(spec.tools[0].name, 'structured_output')
  assert.equal(spec.tools[0].parameters.type, 'object', 'the audit answers through a schema, not a tool loop')
  assert.ok(spec.tools[0].parameters.properties.ops, 'the schema must demand an ops array')
  assert.equal(spec.purpose, 'compaction', 'auxiliary-call classification, like harness compaction')
  assert.equal(spec.sessionId, 'session-1')
  assert.equal(spec.messages.length, 1, 'one user turn — no agent envelope to replay')
  // The audit answers in one call only if it is not made to fetch the tree.
  const text = spec.messages[0].content[0].text
  assert.match(text, /Current index \(MEMORY\.md\)/)
  assert.match(text, /memory:\/\/core\/user\/no_detours/)
  assert.match(text, /主人受不了绕弯子/, 'node bodies must travel with the task')
  // Speed contract: a routed `max` must never leak into the audit call.
  assert.equal(spec.reasoningEffort, undefined, 'reasoning effort is the adapter default unless configured')
})

test('compact applies the returned plan and rebuilds the index', async () => {
  const root = withMemory(workspace())
  const plan = {
    ops: [
      {
        op: 'update',
        uri: 'memory://core/user/think_before_speaking',
        content: '主人要我深入思考。他还受不了绕弯子，回答先给结论，坏消息也一样直给。',
        priority: 1,
        disclosure: '每次组织回复时：先想清楚，再给结论，不绕',
        triggers: ['结论', '不绕'],
        reason: 'fold no_detours into the stronger node',
      },
      { op: 'alias', uri: 'memory://core/user/no_detours', target: 'memory://core/user/think_before_speaking', reason: 'keep the old doorway' },
    ],
  }
  const { run } = harness(root, {}, { response: { plan } })
  const result = await run('compact deepseek')

  assert.equal(result.kind, 'success', `compact must succeed, got: ${JSON.stringify(result)}`)
  assert.match(result.text, /updated 1, aliased 1, deleted 0/)
  assert.match(readMemory(root, 'memory://core/user/think_before_speaking'), /坏消息也一样直给/)
  assert.match(readMemory(root, 'memory://core/user/think_before_speaking'), /不绕/)
  const alias = readMemory(root, 'memory://core/user/no_detours')
  assert.match(alias, /aliasOf: "memory:\/\/core\/user\/think_before_speaking"/)
  assert.doesNotMatch(alias, /绕弯子/, 'an alias carries no body of its own')
  const index = readFileSync(join(root, '.persona', 'deepseek', 'MEMORY.md'), 'utf8')
  assert.match(index, /memory:\/\/core\/user\/no_detours — alias→memory:\/\/core\/user\/think_before_speaking/)
  assert.match(index, /先想清楚，再给结论，不绕/, 'the index row must carry the rewritten disclosure')
})

test('a refused plan leaves the memory tree untouched', async () => {
  const root = withMemory(workspace())
  const before = readMemory(root, 'memory://core/user/no_detours')
  // Naming a node that does not exist is exactly the kind of plan the validator
  // exists to stop before any write lands.
  const { run } = harness(root, {}, { response: { plan: { ops: [{ op: 'delete', uri: 'memory://core/ghost' }] } } })
  const result = await run('compact deepseek')

  assert.equal(result.kind, 'error', `a refused plan must fail loudly, got: ${JSON.stringify(result)}`)
  assert.match(result.text, /plan refused, memory tree untouched/)
  assert.equal(readMemory(root, 'memory://core/user/no_detours'), before)
  assert.ok(existsSync(join(root, '.persona', 'deepseek', 'memory', 'core', 'user', 'think_before_speaking.md')), 'nothing may be deleted')
})

test('an answer with no plan is re-asked once, then reported and applied as nothing', async () => {
  const root = withMemory(workspace())
  const before = readMemory(root, 'memory://core/user/no_detours')
  const { run, calls } = harness(root, {}, { response: { text: 'I could not decide; the tree looks fine.' } })
  const result = await run('compact deepseek')

  assert.equal(result.kind, 'error')
  assert.match(result.text, /produced no plan/)
  assert.equal(calls.llm.length, 2, 'one re-ask, then give up')
  assert.match(calls.llm[1].messages[0].content[0].text, /did not yield a complete plan/, 'the re-ask says what was wrong')
  assert.equal(readMemory(root, 'memory://core/user/no_detours'), before, 'an absent plan is not an empty plan')
})

test('a text-only answer still lands when it carries the plan as JSON', async () => {
  const root = withMemory(workspace())
  const plan = { ops: [{ op: 'update', uri: 'memory://core/user/no_detours', content: '主人受不了绕弯子，回答先给结论。', priority: 2, disclosure: '每次组织回复时记得：结论先行', triggers: ['绕弯'], reason: 'densify' }] }
  const { run } = harness(root, {}, { response: { text: `Here is my plan:\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` } })
  const result = await run('compact deepseek')

  assert.equal(result.kind, 'success', `a JSON fallback must land, got: ${JSON.stringify(result)}`)
  assert.match(result.text, /updated 1, aliased 0, deleted 0/)
})

test('a failed call is reported; a truncated one escalates then fails closed', async () => {
  const root = withMemory(workspace())
  const before = readMemory(root, 'memory://core/user/no_detours')

  const failed = await harness(root, {}, { response: { throw: 'provider unreachable' } }).run('compact deepseek')
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /provider unreachable/)

  // A small configured cap, always truncating: it doubles once, then gives up.
  const { run, calls } = harness(root, {}, {
    cfg: { compactMaxTokens: 8_192 },
    response: { plan: { ops: [] }, finish: { kind: 'max-tokens' } },
  })
  const truncated = await run('compact deepseek')
  assert.equal(truncated.kind, 'error')
  assert.match(truncated.text, /token cap/)
  assert.equal(calls.llm.length, 2, 'one escalated re-ask, then give up')
  assert.equal(calls.llm[0].maxTokens, 8_192)
  assert.equal(calls.llm[1].maxTokens, 16_384, 'the cap doubles toward the 65_536 ceiling')

  // At the default cap — the harness's own 65_536 — there is nowhere to
  // escalate, so truncation fails after the first call.
  const big = await harness(root, {}, { response: { finish: { kind: 'max-tokens' } } }).run('compact deepseek')
  assert.equal(big.kind, 'error')
  assert.match(big.text, /token cap \(maxTokens 65536\)/)

  assert.equal(readMemory(root, 'memory://core/user/no_detours'), before)
})

test('a truncated first answer lands on the escalated second attempt', async () => {
  const root = withMemory(workspace())
  const plan = { ops: [{ op: 'update', uri: 'memory://core/user/no_detours', content: '主人受不了绕弯子，回答先给结论。', priority: 2, disclosure: '每次组织回复时：结论先行', triggers: ['绕弯'], reason: 'densify' }] }
  const { run, calls } = harness(root, {}, {
    cfg: { compactMaxTokens: 8_192 },
    responses: [
      { finish: { kind: 'max-tokens' } },
      { plan },
    ],
  })
  const result = await run('compact deepseek')

  assert.equal(result.kind, 'success', `the escalated retry must land, got: ${JSON.stringify(result)}`)
  assert.equal(calls.llm.length, 2)
  assert.match(calls.llm[1].messages[0].content[0].text, /cut off by the token cap/, 'the re-ask names the truncation')
  assert.match(result.text, /updated 1, aliased 0, deleted 0/)
})

test('spawn and compact still reject an unknown persona before any spawn', async () => {
  const { run, calls } = harness(workspace())
  for (const line of ['spawn nobody', 'compact nobody']) {
    const result = await run(line)
    assert.equal(result.kind, 'error', `${line} must fail`)
    assert.match(result.text, /not found/)
  }
  assert.equal(calls.startContinuable.length + calls.start.length + calls.llm.length, 0, 'no work starts for a missing persona')
})

test('spawn and compact still require a name', async () => {
  const { run, calls } = harness(workspace())
  for (const line of ['spawn', 'compact']) {
    const result = await run(line)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /usage:/)
  }
  assert.equal(calls.startContinuable.length + calls.start.length + calls.llm.length, 0)
})

test('spawn registers the CHILD session in the binding ledger', async () => {
  const root = workspace()
  const { run, calls } = harness(root)
  const result = await run('spawn deepseek 打个招呼')

  assert.equal(result.kind, 'success', `spawn must succeed, got: ${JSON.stringify(result)}`)
  const childId = calls.startContinuable[0].childId
  assert.equal(bindingOf(root, childId)?.name, 'deepseek', 'the child session must own a ledger row')
  // The child id is a bare uuid — NOT the parent's `session-…` header id. The
  // row must be keyed by the child, because that is the id the picker receives
  // and the id `agent/created` reads back on resume.
  assert.doesNotMatch(childId, /^session-/, 'a subagent child id is a bare uuid')
  assert.equal(bindingOf(root, 'session-1'), undefined, 'spawn must not bind the parent session')
  assert.doesNotMatch(result.text, /not persisted/, 'a healthy write reports nothing')
})

test('compact leaves no child session and no ledger row behind', async () => {
  const root = workspace()
  const { run, calls } = harness(root, {}, { response: { plan: { ops: [] } } })
  const result = await run('compact deepseek')

  assert.equal(result.kind, 'success', `compact must succeed, got: ${JSON.stringify(result)}`)
  assert.equal(calls.start.length + calls.startContinuable.length, 0, 'no child session exists to badge')
  assert.equal(bindingOf(root, 'child-compact-1'), undefined)
  assert.equal(existsSync(join(libraryRoot(root), '.bindings')), false, 'compact must not touch the ledger at all')
  assert.doesNotMatch(result.text, /not persisted/)
})

test('use registers the session it equipped', async () => {
  const root = workspace()
  const { run } = harness(root)
  const result = await run('use deepseek')

  assert.equal(result.kind, 'success', `use must succeed, got: ${JSON.stringify(result)}`)
  assert.equal(bindingOf(root, 'session-1')?.name, 'deepseek')
})

test('off clears the binding of the session that owns it — child ids included', async () => {
  const root = workspace()
  // A subagent child: one bare uuid is both the agent id and the session id, and
  // `off` reads agent.personaEquip while it clears the ledger by session id —
  // the two must agree or a child could never unbind itself.
  const childId = 'ae841f22-5353-4fb5-9a4a-7bbed2b4a042'
  const { run } = harness(root, { agentId: childId, sessionId: childId })

  const used = await run('use deepseek')
  assert.equal(used.kind, 'success', `use must succeed, got: ${JSON.stringify(used)}`)
  assert.equal(bindingOf(root, childId)?.name, 'deepseek')

  const off = await run('off')
  assert.equal(off.kind, 'success', `off must succeed, got: ${JSON.stringify(off)}`)
  assert.equal(bindingOf(root, childId), undefined, 'off must remove the row it wrote')
})

test('a failed ledger write is reported but never fails the command', async () => {
  const root = workspace()
  // A FILE where the ledger directory belongs: `mkdirSync(recursive)` cannot
  // create it, so the write throws — the equip/spawn already happened, so the
  // reply must still be a success that names the consequence.
  writeFileSync(join(libraryRoot(root), '.bindings'), 'not a directory', 'utf8')
  const { run, calls } = harness(root)

  const spawned = await run('spawn deepseek')
  assert.equal(spawned.kind, 'success', 'a spawn that happened is not undone by a failed write')
  assert.match(spawned.text, /not persisted/, 'the failure must be loud')
  assert.equal(bindingOf(root, calls.startContinuable[0].childId), undefined)
})

test('a failed spawn leaves no zombie pending entry', async () => {
  const root = workspace()
  const { run, ctx } = harness(root)
  ctx.subagents.startContinuable = async () => { throw new Error('Illegal constructor') }
  const sizeBefore = pendingContinuable.size

  await assert.rejects(run('spawn deepseek'), /Illegal constructor/)
  assert.equal(pendingContinuable.size, sizeBefore, 'a failed spawn must not leave a pending entry')
})

test('a second use is refused politely — never a raw section error', async () => {
  const root = workspace()
  const { run } = harness(root)

  const first = await run('use deepseek')
  assert.equal(first.kind, 'success')
  const again = await run('use deepseek')
  assert.equal(again.kind, 'error')
  assert.match(again.text, /already equipped as "deepseek" — unequip it first/)
})

test('off on an unequipped session says so', async () => {
  const { run } = harness(workspace())
  const result = await run('off')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no persona equipped/)
})

test('status reads the equip on the agent itself', async () => {
  const root = workspace()
  const { run } = harness(root)

  assert.match((await run('status')).text, /equipped: none/)
  await run('use deepseek')
  assert.match((await run('status')).text, /equipped: deepseek/)
})

/**
 * The module-level `equipped` Map used to be the authority: a plugin reload
 * (HMR) rebuilt the map while the agent stayed alive, so `use`/`off`/`status`
 * in the NEW module instance saw an empty table and lied — `use` crashed on a
 * duplicated `persona:protocol` section, `off` claimed nothing was equipped.
 * The state must live on the agent (agent.id === session.id), not on a module.
 * A second registerCommands(ctx2, …) with the SAME agent simulates the reload.
 */
test('HMR: a reloaded command context still sees and removes the equip', async () => {
  const root = workspace()
  const h1 = harness(root)
  const used = await h1.run('use deepseek')
  assert.equal(used.kind, 'success')

  // "Reload": a fresh commands registration against a fresh ctx, same agent.
  const sameAgent = h1.agent
  const command2 = { handler: undefined }
  const ctx2 = {
    commands: { register: (spec) => { command2.handler = spec.handler } },
    subagents: { startContinuable: async () => ({}), start: async () => ({ id: 'x', result: Promise.resolve({}) }) },
  }
  const cfg = { libraryDir: '.persona', providerName: 'persona' }
  registerCommands(ctx2, cfg, () => root)
  const again = await command2.handler({ agent: sameAgent, rawInput: 'use deepseek' })
  assert.equal(again.kind, 'error', 'a reloaded module must still see the equip')
  assert.match(again.text, /already equipped/)

  const status = await command2.handler({ agent: sameAgent, rawInput: 'status' })
  assert.match(status.text, /equipped: deepseek/)

  const off = await command2.handler({ agent: sameAgent, rawInput: 'off' })
  assert.equal(off.kind, 'success', `off must unequip, got: ${JSON.stringify(off)}`)
  assert.equal(sameAgent.personaEquip, undefined)
  assert.equal(bindingOf(root, 'session-1'), undefined)
  assert.equal(sameAgent.ctx.registered.size, 0, 'off must actually dispose the tool registrations')
  assert.equal(sameAgent.ctx.sections.length, 0, 'off must actually dispose the prompt sections')
})

test('new --from copies a bundled example archive, memory tree included', async () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-ex-'))
  const { run } = harness(root)

  const created = await run('new --from deepseek')
  assert.equal(created.kind, 'success', `example creation failed: ${JSON.stringify(created)}`)
  assert.match(created.text, /from example "deepseek"/)

  const dir = join(root, '.persona', 'deepseek')
  // It is a real archive: persona_exists would see it, and the frontmatter
  // parses through the same minimal grammar savePersona validates with.
  const profile = readFileSync(join(dir, 'PERSONA.md'), 'utf8')
  assert.match(profile, /^name: deepseek$/m)
  assert.match(profile, /^description:/m)
  // The shipped memory tree came along — an example with no memory would be
  // a profile, not a persona.
  assert.equal(existsSync(join(dir, 'memory', 'core', 'identity.md')), true)
  assert.equal(existsSync(join(dir, 'STATE.md')), true)
  assert.equal(existsSync(join(dir, 'MEMORY.md')), true)

  // Equipping it works — this is the whole point of the example.
  const equipped = await run('use deepseek')
  assert.equal(equipped.kind, 'success', `use failed: ${JSON.stringify(equipped)}`)
})

test('new --from renames the archive: name and frontmatter stay in step', async () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-ex-rename-'))
  const { run } = harness(root)

  const created = await run('new moby --from deepseek')
  assert.equal(created.kind, 'success', JSON.stringify(created))
  const profile = readFileSync(join(root, '.persona', 'moby', 'PERSONA.md'), 'utf8')
  assert.match(profile, /^name: moby$/m)
  assert.doesNotMatch(profile, /^name: deepseek$/m)
})

test('new --from refuses a takeover: an existing archive is never overwritten', async () => {
  const root = workspace()   // already holds a "deepseek" persona
  const { run } = harness(root)
  const result = await run('new --from deepseek')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /already exists/)
  // And the pre-existing archive is untouched.
  const profile = readFileSync(join(root, '.persona', 'deepseek', 'PERSONA.md'), 'utf8')
  assert.match(profile, /鲸萝/)
})

test('new --from names its unknown example and lists what exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-ex-miss-'))
  const { run } = harness(root)
  const result = await run('new --from nosuch')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unknown example "nosuch"/)
  assert.match(result.text, /deepseek/)
})

test('examples lists every bundled example with its description', async () => {
  const root = workspace()
  const { run } = harness(root)
  const result = await run('examples')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /deepseek:/)
  assert.match(result.text, /--from <example>/)
})
