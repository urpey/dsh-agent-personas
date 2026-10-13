/**
 * Plugin-entry coverage for the `agent/created` equip listener.
 *
 * The `.persona/.bindings/` ledger is the ONE durable channel that re-equips a
 * session after a restart — for a root session (`/persona use`) and for a
 * spawned child alike — and a `subagent/descriptor` marker is NOT a second one.
 * The marker branch that used to sit here could never fire: continuable spawns
 * carry persona BODY text only (`lib/provider.js` `personaBodyText`), so no
 * descriptor ever held a `persona-profile:` line to parse. A child that spawns
 * without a ledger row is equipped-but-invisible, which is exactly the bug this
 * file pins: the badge and the resume both read the same row.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import plugin from '../index.js'
import { libraryRoot } from '../lib/persona.js'
import { pendingOneShot, pendingContinuable } from '../lib/provider.js'

/** A workspace holding one usable persona archive. */
function workspace(name = 'deepseek') {
  const root = mkdtempSync(join(tmpdir(), 'persona-plugin-'))
  mkdirSync(join(root, '.persona', name), { recursive: true })
  writeFileSync(
    join(root, '.persona', name, 'PERSONA.md'),
    `---\nname: ${name}\ndescription: 大肥鱼\n---\n\n## Layer 1 · Core Self\n\n- **identity**: 鲸萝\n`,
    'utf8',
  )
  return root
}

/** Register a session id in the ledger the way an equip path does. */
function register(root, sessionId, name = 'deepseek') {
  mkdirSync(join(libraryRoot(root), '.bindings'), { recursive: true })
  writeFileSync(join(libraryRoot(root), '.bindings', `${sessionId}.json`), JSON.stringify({ name, boundAt: 1 }), 'utf8')
}

/**
 * Mount the plugin on a recording ctx.
 * @param root - workspace root the plugin resolves an agent's cwd to.
 * @returns the `agent/created` listener and the tools the plugin registered.
 */
function mount(root) {
  const listeners = {}
  const providers = new Map()
  const tools = new Map()
  const ctx = {
    on: (name, fn) => { (listeners[name] ??= []).push(fn); return () => {} },
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    commands: { register: () => () => {} },
    subagents: {
      registerProvider: (provider) => { providers.set(provider.name, provider); return () => {} },
      getProvider: (name) => providers.get(name),
      async startContinuable(spec) {
        return { childId: spec.childId, messageId: 'msg-continuable' }
      },
      async start() {
        return { id: 'child-oneshot-tool', result: Promise.resolve({ stopReason: 'stop', output: [] }) }
      },
    },
  }
  plugin.apply(ctx, { libraryDir: '.persona' })
  const created = listeners['agent/created']?.[0]
  assert.equal(typeof created, 'function', 'the plugin watches agent/created')
  return { created, tools, providers, ctx }
}

/** The binding row a session id was registered under, or undefined. */
function bindingOf(root, sessionId) {
  try {
    return JSON.parse(readFileSync(join(libraryRoot(root), '.bindings', `${sessionId}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

/** Minimal agent for the equip listener: it reaches for `session` and `ctx`. */
function agent(root, id, events = []) {
  const handlers = {}
  const registered = new Map()
  const sections = []
  return {
    id,
    session: { header: { id, cwd: root }, id, deriveMessages: () => [], snapshotEvents: () => events },
    inject: () => {},
    followup: () => {},
    ctx: {
      handlers,
      registered,
      sections,
      systemPrompt: { section: (section) => { sections.push(section); return () => {} }, getSectionOrder: () => 0 },
      on: (name, fn) => { (handlers[name] ??= []).push(fn); return () => {} },
      tools: { register: (def) => { registered.set(def.name, def); return () => {} } },
      logger: { warn: () => {} },
    },
  }
}

/** Equipped agents carry the gate tool; unequipped ones carry nothing. */
const equipped = (a) => a.ctx.registered.has('persona_gate')

test('a resumed CHILD session re-equips from its ledger row', () => {
  const root = workspace()
  const { created } = mount(root)
  // A subagent child id is a bare uuid — no `session-` prefix — so the row has
  // to be keyed by the header id the picker and the resume both receive.
  const childId = 'ae841f22-5353-4fb5-9a4a-7bbed2b4a042'
  register(root, childId)

  const child = agent(root, childId)
  created({ agent: child })

  assert.equal(equipped(child), true, 'a child with a ledger row must be equipped on resume')
  assert.ok(child.ctx.sections.some(section => section.name === 'deployment:persona-prefix'))
  assert.equal(child.personaEquip?.name, 'deepseek', 'the equip handle lives on the agent itself')
})

test('agent/created is idempotent on an already-equipped agent', () => {
  const root = workspace()
  const { created } = mount(root)
  const childId = 'ae841f22-5353-4fb5-9a4a-7bbed2b4a042'
  register(root, childId)

  const child = agent(root, childId)
  created({ agent: child })
  const sectionsAfterFirst = child.ctx.sections.length
  const equipAfterFirst = child.personaEquip

  created({ agent: child })   // a duplicate announcement must be a no-op

  assert.equal(child.ctx.sections.length, sectionsAfterFirst, 're-announcing must not re-equip')
  assert.equal(child.personaEquip, equipAfterFirst, 'the same equip handle must survive')
})

test('a resumed ROOT session re-equips from its ledger row', () => {
  const root = workspace()
  const { created } = mount(root)
  const sessionId = 'session-45afa900-2096-4a56-9bba-8ce5756aab4e'
  register(root, sessionId)

  const root_ = agent(root, sessionId)
  created({ agent: root_ })

  assert.equal(equipped(root_), true)
  assert.equal(root_.personaEquip?.name, 'deepseek')
})

test('an unregistered session is left alone', () => {
  const root = workspace()
  const { created } = mount(root)
  const stranger = agent(root, 'session-never-equipped')
  created({ agent: stranger })
  assert.equal(equipped(stranger), false)
})

test('a descriptor marker is not a second binding channel', () => {
  const root = workspace()
  const { created } = mount(root)
  // The exact shape the retired branch looked for — and the exact reason it was
  // dead: a continuable spawn stores persona BODY text, so this marker only ever
  // appears in a payload the plugin itself never produces.
  const descriptor = {
    type: 'subagent/descriptor',
    seq: 0,
    data: {
      version: 3,
      mode: 'continuable',
      provider: 'persona',
      label: 'persona:deepseek',
      persona: 'persona-profile:deepseek\n\n## Layer 1 · Core Self\n',
    },
  }
  const child = agent(root, 'child-with-marker-only', [descriptor])
  created({ agent: child })

  assert.equal(equipped(child), false, 'without a ledger row there is no binding to honour')
})

test('a ledger row naming a deleted archive is dropped, not honoured', () => {
  const root = workspace()
  const { created } = mount(root)
  const sessionId = 'session-stale'
  register(root, sessionId, 'ghost')

  const stale = agent(root, sessionId)
  created({ agent: stale })

  assert.equal(equipped(stale), false, 'the archive is gone, so there is nothing to equip')
})

test('a failed one-shot start unqueues its pending entry', async () => {
  const root = workspace()
  const { providers } = mount(root)
  // A throwing inner 'spawn' provider: the child never arrives, so the FIFO
  // entry the provider just queued would otherwise stick — and would name the
  // NEXT one-shot child of this parent.
  providers.set('spawn', { name: 'spawn', start: async () => { throw new Error('boom') } })
  const persona = providers.get('persona')
  const parent = { session: { header: { id: 'parent-1', cwd: root } }, id: 'parent-1' }
  const sizeBefore = pendingOneShot.get('parent-1')?.length ?? 0

  await assert.rejects(
    persona.start({
      parent,
      persona: 'persona-profile:deepseek\n\ntext',
      prompt: [{ type: 'text', text: 'x' }],
    }),
    /boom/,
  )
  assert.equal(pendingOneShot.get('parent-1')?.length ?? 0, sizeBefore, 'a failed start must not leave a pending entry')
})

test('a failed persona_spawn startContinuable leaves no pending entry', async () => {
  const root = workspace()
  const { tools, ctx } = mount(root)
  const spawn = tools.get('persona_spawn')
  const parent = agent(root, 'session-parent')
  ctx.subagents.startContinuable = async () => { throw new Error('Illegal constructor') }
  const sizeBefore = pendingContinuable.size

  await assert.rejects(
    spawn.execute({ name: 'deepseek', prompt: 'hi' }, { agent: parent }),
    /Illegal constructor/,
  )
  assert.equal(pendingContinuable.size, sizeBefore, 'a failed spawn must not leave a zombie pending entry')
})

test('the persona_spawn tool registers the child it creates, in both modes', async () => {
  const root = workspace()
  const { tools } = mount(root)
  const spawn = tools.get('persona_spawn')
  assert.equal(typeof spawn?.execute, 'function', 'the plugin registers persona_spawn')
  const parent = agent(root, 'session-parent')

  const continuable = await spawn.execute({ name: 'deepseek', prompt: 'hi' }, { agent: parent })
  assert.equal(bindingOf(root, continuable.childId)?.name, 'deepseek', 'the continuable child must be registered')
  assert.equal(continuable.bindingNote, '', 'a healthy write reports nothing')

  const oneShot = await spawn.execute({ name: 'deepseek', prompt: 'hi', mode: 'one-shot' }, { agent: parent })
  assert.equal(bindingOf(root, oneShot.childId)?.name, 'deepseek', 'the one-shot child must be registered too')
  assert.equal(oneShot.bindingNote, '')
})
