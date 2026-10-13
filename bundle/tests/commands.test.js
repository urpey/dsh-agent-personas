/**
 * `/persona spawn|compact` regression coverage.
 *
 * Both subcommands hand a signal to the subagent service, which calls
 * `signal.throwIfAborted()` on it. `new AbortSignal()` — the shape this code
 * used to carry — is a TypeError ("Illegal constructor"), so every popup pick of
 * 派生/压缩 died on the Host with `command/done { kind: "error", text: "Illegal
 * constructor" }`. These tests drive the real handler and assert the signal that
 * actually reaches `ctx.subagents`.
 *
 * They also pin the OTHER half of the same contract: every path that equips a
 * child session must register that child in the `.persona/.bindings/` ledger.
 * The ledger is what the `/personas` picker badges and what re-equips a session
 * after a restart, so an unregistered child is equipped-but-invisible.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
 * Register the commands against a recording ctx and return a runner.
 * @param root - workspace root the handler resolves its cwd to.
 * @param ids - `agentId`/`sessionId` identity for the agent under test.
 */
function harness(root, ids = {}) {
  const calls = { startContinuable: [], start: [] }
  const command = { handler: undefined }
  const ctx = {
    commands: { register: (spec) => { command.handler = spec.handler } },
    subagents: {
      async startContinuable(spec) {
        calls.startContinuable.push(spec)
        return { childId: spec.childId, messageId: 'msg-1' }
      },
      async start(_provider, spec) {
        calls.start.push(spec)
        return {
          id: 'child-compact-1',
          result: Promise.resolve({ stopReason: 'stop', output: [{ type: 'text', text: '压缩完成' }] }),
        }
      },
    },
  }
  const cfg = { libraryDir: '.persona', providerName: 'persona' }
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

test('compact hands the subagent service a live AbortSignal', async () => {
  const { run, calls } = harness(workspace())
  const result = await run('compact deepseek')

  assert.equal(result.kind, 'success', `compact must succeed, got: ${JSON.stringify(result)}`)
  assert.equal(calls.start.length, 1)
  assertLiveSignal(calls.start[0].signal)
  assert.match(result.text, /压缩完成/)
})

test('spawn and compact still reject an unknown persona before any spawn', async () => {
  const { run, calls } = harness(workspace())
  for (const line of ['spawn nobody', 'compact nobody']) {
    const result = await run(line)
    assert.equal(result.kind, 'error', `${line} must fail`)
    assert.match(result.text, /not found/)
  }
  assert.equal(calls.startContinuable.length + calls.start.length, 0, 'no subagent starts for a missing persona')
})

test('spawn and compact still require a name', async () => {
  const { run, calls } = harness(workspace())
  for (const line of ['spawn', 'compact']) {
    const result = await run(line)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /usage:/)
  }
  assert.equal(calls.startContinuable.length + calls.start.length, 0)
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

test('compact registers the one-shot CHILD session in the binding ledger', async () => {
  const root = workspace()
  const { run } = harness(root)
  const result = await run('compact deepseek')

  assert.equal(result.kind, 'success', `compact must succeed, got: ${JSON.stringify(result)}`)
  assert.equal(bindingOf(root, 'child-compact-1')?.name, 'deepseek')
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
  assert.match(again.text, /already equipped as "deepseek" — \/persona off first/)
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
