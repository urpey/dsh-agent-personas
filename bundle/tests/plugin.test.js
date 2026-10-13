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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import plugin from '../index.js'
import { libraryRoot, listPersonas } from '../lib/persona.js'
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
 * @returns the `agent/created` listener, the tools and skills it registered.
 */
function mount(root) {
  const listeners = {}
  const providers = new Map()
  const tools = new Map()
  const skills = new Map()
  const ctx = {
    on: (name, fn) => { (listeners[name] ??= []).push(fn); return () => {} },
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    commands: { register: () => () => {} },
    // `ctx.inject` is how the plugin reaches an OPTIONAL service. The skill
    // registry ships in every profile, but the persona engine must not fail to
    // load without it — so the plugin asks, and this stub answers.
    inject: (deps, callback) => {
      if (deps.includes('skills')) {
        callback({ skills: { register: (def) => { skills.set(def.name, def); return () => {} } } })
      }
      return () => {}
    },
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
  return { created, tools, providers, ctx, skills }
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

// ------------------------------------------------------------ authoring tools

/** A draft that passes every `persona_save` check, for one archive name. */
function draft(name) {
  return {
    'PERSONA.md': `---\nname: ${name}\ndescription: 一条线\ntriggers: []\nmbti: INTP\ninterests: []\nreactions: {}\n---\n\n## Layer 1 · Core Self\n\n- **identity**: 一条线\n`,
    'STATE.md': `---\nbase:\n  energy: { max: 100, value: 80 }\npalam:\n  joy: { emit: favor, per: 100, decay: 20, value: 0 }\njuel:\n  favor: 0\nstats: {}\nmarks: {}\nrelations:\n  lead: { value: 0 }\nbuffs: []\n---\n\n## Notes\n`,
    'memory/core/identity.md': `---\ntitle: identity\ndisclosure: always\n---\n\nI am ${name}.\n`,
  }
}

test('persona_save creates the archive and fills an omitted skeleton from the template', async () => {
  const root = workspace()
  const { tools } = mount(root)
  const save = tools.get('persona_save')
  assert.equal(typeof save?.execute, 'function', 'the plugin registers persona_save')

  // PERSONA.md and one memory node only: STATE.md and MEMORY.md are the host's
  // job, so an author who omitted them still gets a loadable archive.
  const files = draft('lifeline')
  delete files['STATE.md']
  const result = await save.execute({ name: 'lifeline', files }, { agent: agent(root, 'session-author') })

  assert.equal(result.error, undefined)
  assert.equal(result.created, 'lifeline')
  const dir = join(root, '.persona', 'lifeline')
  assert.ok(existsSync(join(dir, 'PERSONA.md')), 'the drafted profile lands verbatim')
  assert.ok(existsSync(join(dir, 'STATE.md')), 'an omitted STATE.md is filled from the template')
  assert.ok(existsSync(join(dir, 'MEMORY.md')), 'an omitted MEMORY.md is filled from the template')
  assert.ok(existsSync(join(dir, 'memory', 'core', 'identity.md')), 'a nested memory node is created with its directories')
  assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /# Memory Index — lifeline/, '{{name}} is substituted')
  assert.match(readFileSync(join(dir, 'PERSONA.md'), 'utf8'), /一条线/, 'the draft is not replaced by the template')
})

test('persona_save refuses every malformed draft before writing anything', async () => {
  const root = workspace()
  const { tools } = mount(root)
  const save = tools.get('persona_save')
  const author = agent(root, 'session-author')
  const profile = (name) => draft(name)['PERSONA.md']

  const cases = [
    ['an illegal name', { name: 'bad name!', files: draft('bad') }, 'a1'],
    ['a path outside the archive', { name: 'a1', files: { 'PERSONA.md': profile('a1'), '../escape.md': 'x' } }, 'a1'],
    ['an absolute path', { name: 'a2', files: { 'PERSONA.md': profile('a2'), '/etc/passwd': 'x' } }, 'a2'],
    ['an unknown top-level file', { name: 'a3', files: { 'PERSONA.md': profile('a3'), 'SECRET.md': 'x' } }, 'a3'],
    ['a memory node that is not markdown', { name: 'a4', files: { 'PERSONA.md': profile('a4'), 'memory/core/identity.txt': 'x' } }, 'a4'],
    ['a draft with no PERSONA.md', { name: 'a5', files: { 'STATE.md': draft('a5')['STATE.md'] } }, 'a5'],
    ['frontmatter outside the parser grammar', { name: 'a6', files: { 'PERSONA.md': '---\n{ a: 1 # note }\n---\n\nx\n' } }, 'a6'],
    ['a profile with no frontmatter block', { name: 'a7', files: { 'PERSONA.md': '## Layer 1 · Core Self\n' } }, 'a7'],
    ['a non-string file body', { name: 'a8', files: { 'PERSONA.md': profile('a8'), 'STATE.md': 42 } }, 'a8'],
    ['files that are not an object', { name: 'a9', files: null }, 'a9'],
  ]

  for (const [label, args, name] of cases) {
    const result = await save.execute(args, { agent: author })
    assert.equal(typeof result.error, 'string', `${label}: must be refused`)
    assert.equal(result.created, undefined, `${label}: must not report a creation`)
    assert.equal(existsSync(join(root, '.persona', name)), false, `${label}: must not touch the disk`)
  }
})

test('persona_save never overwrites an existing archive', async () => {
  const root = workspace()
  const { tools } = mount(root)
  const before = readFileSync(join(root, '.persona', 'deepseek', 'PERSONA.md'), 'utf8')

  const result = await tools.get('persona_save')
    .execute({ name: 'deepseek', files: draft('deepseek') }, { agent: agent(root, 'session-author') })

  assert.match(result.error, /already exists/)
  assert.equal(
    readFileSync(join(root, '.persona', 'deepseek', 'PERSONA.md'), 'utf8'), before,
    'the existing archive must be byte-identical — creation only, never a rewrite',
  )
})

test('persona_save refuses to rewrite the persona this session is running as', async () => {
  const root = workspace()
  const { tools, created } = mount(root)
  const sessionId = 'session-running'
  register(root, sessionId)
  const running = agent(root, sessionId)
  created({ agent: running })
  assert.equal(running.personaEquip?.name, 'deepseek', 'the session is running as deepseek')

  const result = await tools.get('persona_save')
    .execute({ name: 'deepseek', files: draft('deepseek') }, { agent: running })

  assert.match(result.error, /running as/)
  assert.equal(result.created, undefined)
})

test('persona_save will not resurrect a live archive that was deleted under it', async () => {
  const root = workspace()
  const { tools, created } = mount(root)
  const sessionId = 'session-running-deleted'
  register(root, sessionId)
  const running = agent(root, sessionId)
  created({ agent: running })

  // The existence check no longer catches this one — the directory is gone —
  // so the "running as" guard is the only thing standing between a live session
  // and its own archive being rebuilt from a draft.
  rmSync(join(root, '.persona', 'deepseek'), { recursive: true })
  const result = await tools.get('persona_save')
    .execute({ name: 'deepseek', files: draft('deepseek') }, { agent: running })

  assert.match(result.error, /running as/)
  assert.equal(existsSync(join(root, '.persona', 'deepseek')), false, 'nothing may be written')
})

test('the persona_use tool equips and registers the session exactly like /persona use', () => {
  const root = workspace()
  const { tools } = mount(root)
  const use = tools.get('persona_use')
  assert.equal(typeof use?.execute, 'function', 'the plugin registers persona_use')

  const sessionId = 'session-tool-equip'
  const target = agent(root, sessionId)
  const result = use.execute({ name: 'deepseek' }, { agent: target })

  assert.equal(result.error, undefined)
  assert.equal(result.equipped, 'deepseek')
  assert.equal(target.personaEquip?.name, 'deepseek', 'the equip handle lives on the agent')
  assert.equal(bindingOf(root, sessionId)?.name, 'deepseek', 'the ledger row is the durable half')
  assert.equal(result.bindingNote, '', 'a healthy write reports nothing')

  const again = use.execute({ name: 'deepseek' }, { agent: target })
  assert.match(again.error, /already equipped as "deepseek" — \/persona off first/)
})

test('the persona_use tool refuses an archive that does not exist', () => {
  const root = workspace()
  const { tools } = mount(root)
  const result = tools.get('persona_use').execute({ name: 'ghost' }, { agent: agent(root, 'session-x') })
  assert.match(result.error, /not found/)
})

test('the authoring skill reaches the catalog as a runtime skill', () => {
  const root = workspace()
  const { skills } = mount(root)
  const skill = skills.get('persona-authoring')
  assert.equal(skill?.source, 'runtime')
  assert.equal(skill?.provider, 'agent-personas')
  assert.equal(typeof skill.description, 'string')
  assert.ok(skill.description.length > 0, 'the registry rejects a skill with no description')
  assert.ok(skill.content.length > 0, 'the body is what gets injected')
  assert.equal(skill.content.startsWith('---'), false, 'frontmatter is stripped from the injected body')
  assert.equal(skill.resourceBase?.kind, 'directory')
  assert.ok(existsSync(join(skill.resourceBase.path, 'SKILL.md')), 'relative resources resolve against the skill directory')
})

test('the wizard chain closes: a saved draft becomes a live, equipped persona', async () => {
  const root = workspace()
  const { tools } = mount(root)
  const author = agent(root, 'session-wizard')

  // 1) The draft the agent authored lands as a real archive — through the
  //    plugin's own tool surface, not by reaching into lib/ directly.
  const saved = await tools.get('persona_save').execute({ name: 'lifeline', files: draft('lifeline') }, { agent: author })
  assert.equal(saved.error, undefined)
  assert.ok(listPersonas(root, '.persona').some(row => row.name === 'lifeline'), 'the new archive is in the library')

  // 2) The user agrees to equip, and the SAME session — which was running as
  //    nothing — picks the persona up without a restart.
  const used = tools.get('persona_use').execute({ name: 'lifeline' }, { agent: author })
  assert.equal(used.error, undefined)
  assert.equal(equipped(author), true, 'the equipped agent carries the persona tool surface')
  assert.equal(author.personaEquip?.name, 'lifeline')
  assert.equal(bindingOf(root, 'session-wizard')?.name, 'lifeline', 'and the binding survives a restart')
})

test('the .persona write guard is untouched: file tools stay denied while persona_save works', async () => {
  const root = workspace()
  const { tools, created } = mount(root)
  const sessionId = 'session-guard'
  register(root, sessionId)
  const running = agent(root, sessionId)
  created({ agent: running })
  assert.equal(running.personaEquip?.name, 'deepseek', 'the session is equipped, so the guard is installed')

  const guard = running.ctx.handlers['tools/pre-execute']?.[0]
  assert.equal(typeof guard, 'function', 'equip installs the .persona write guard')
  const next = async () => ({ kind: 'allow' })

  // The new tool must NOT have been bought by loosening the guard: a direct
  // file write into the library is still refused in an equipped session. That
  // denial is what makes persona_save the only way through, rather than one
  // option among several.
  const denied = await guard({ name: 'write', arguments: { path: '.persona/lifeline/PERSONA.md', content: 'x' } }, next)
  assert.equal(denied.kind, 'deny', 'a direct write into .persona/ must still be refused')
  assert.match(denied.reason, /persona tools/)

  const edit = await guard({ name: 'edit', arguments: { path: '.persona/deepseek/PERSONA.md' } }, next)
  assert.equal(edit.kind, 'deny', 'edit is a write tool too')

  const unrelated = await guard({ name: 'write', arguments: { path: 'src/app.js', content: 'x' } }, next)
  assert.equal(unrelated.kind, 'allow', 'the guard is scoped to the library, not to writing in general')

  // ...and the sanctioned channel still works in that same equipped session.
  const saved = await tools.get('persona_save').execute({ name: 'lifeline', files: draft('lifeline') }, { agent: running })
  assert.equal(saved.error, undefined, 'persona_save is the tool-face channel that survives the guard')
  assert.ok(existsSync(join(root, '.persona', 'lifeline', 'PERSONA.md')))
})
