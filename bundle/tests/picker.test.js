/**
 * `/personas` picker behavior: the client half reads the SESSION WORKSPACE's
 * `.persona/` library through `ctx.remote.workspaceFiles` and must agree with
 * the host's own `listPersonas` semantics (a direct child directory holding
 * `PERSONA.md`), while never letting one bad archive fail the whole popup.
 *
 * The module is loaded the way the browser loads it — a `window.__ModuleLoader__`
 * registration whose factory is materialized with a `require` stub — so these
 * tests exercise the real shipped bundle text, not a copy of its logic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerCommands } from '../lib/commands.js'

const CLIENT_PATH = new URL('../client.js', import.meta.url)

/** Materialize the browser half against a stub module table. */
function loadClient() {
  let registration
  const prior = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(r) { registration = r } } }
  try {
    new Function(readFileSync(CLIENT_PATH, 'utf8'))()
  } finally {
    globalThis.window = prior
  }
  assert.ok(registration, 'client.js must register a lazy factory')
  const React = { createElement: (type, props, ...kids) => ({ type, props, kids }) }
  const plugin = registration.factory((spec) => {
    assert.equal(spec, 'react', `unexpected require(${spec})`)
    return React
  })
  return { id: registration.id, plugin }
}

/**
 * Mount the client half on a fake client ctx whose `workspaceFiles` remote is
 * backed by a real directory tree, so path semantics match the Host's.
 * @param root - workspace root the relative paths resolve against.
 * @param options - `failList` makes every listing answer a carrier failure;
 *   `noBinding` leaves the session unretained; `failPrompt` makes the kickoff
 *   prompt answer a business error.
 */
function mount(root, options = {}) {
  const calls = []
  const notFound = (path) => ({
    ok: false,
    error: { code: 'workspace-file/not-found', message: `no entry at "${path}"` },
  })
  const workspaceFiles = {
    async list(_sessionId, path) {
      calls.push(['list', path])
      if (options.failList === true) return notFound(path)
      const abs = join(root, path)
      if (!existsSync(abs) || !statSync(abs).isDirectory()) return notFound(path)
      return {
        ok: true,
        value: {
          path,
          entries: readdirSync(abs, { withFileTypes: true }).map(d => ({
            name: d.name,
            type: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other',
          })),
          truncated: false,
        },
      }
    },
    async read(_sessionId, path) {
      calls.push(['read', path])
      const abs = join(root, path)
      if (!existsSync(abs) || !statSync(abs).isFile()) return notFound(path)
      return { ok: true, value: { text: readFileSync(abs, 'utf8'), absolutePath: abs, version: 'v' } }
    },
  }

  const dictionaries = new Map()
  const locale = {
    register: (ns, dicts) => { dictionaries.set(ns, dicts); return () => dictionaries.delete(ns) },
    bind: ns => (key, params) => {
      const template = dictionaries.get(ns)?.zh?.[key] ?? key
      return params
        ? template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        : template
    },
  }

  const executed = []
  const submitted = []
  const contributions = []
  const commandUi = {
    register: (contribution) => { contributions.push(contribution); return () => {} },
    decorate: () => () => {},
    dismiss: () => {},
    popupFor: () => undefined,
  }
  const sessions = {
    binding: () => (options.noBinding === true ? undefined : ({
      session: {
        command: async (line) => { executed.push(line); return { ok: true, value: { matched: true } } },
        // The kickoff path goes through the session's prompt face, not its
        // command face: record both so a test can prove which one ran.
        prompt: async (content, mode) => {
          submitted.push({ content, mode })
          if (options.failPrompt === true) return { ok: false, error: new Error('session is busy') }
          return { ok: true, value: { accepted: true } }
        },
      },
    })),
  }
  // The real client ctx exposes the workspace-files namespace under the FLAT
  // service key `remote.workspaceFiles`; there is no nested `remote` service to
  // read a `workspaceFiles` property off. Mirroring that shape is what keeps
  // this harness able to catch a wrong lookup instead of hiding it, and asking
  // for a key nobody provides must fail loudly the way Cordis does — a silent
  // `undefined` is exactly how the 0-persona bug shipped.
  const services = { locale, commandUi, sessions, 'remote.workspaceFiles': workspaceFiles }
  const get = (name) => {
    if (!(name in services)) throw new Error(`cannot get property "${name}" without inject`)
    return services[name]
  }

  const { plugin } = loadClient()
  const injects = []
  plugin.apply({
    get,
    effect: fn => fn(),
    inject: (names, callback) => {
      injects.push(...names)
      return callback({ get, effect: fn => fn() })
    },
  })
  assert.equal(contributions.length, 1, 'exactly one contribution registers')
  assert.ok(
    injects.includes('remote.workspaceFiles'),
    'the contribution must inject the flat remote.workspaceFiles service key',
  )
  return { contribution: contributions[0], executed, submitted, calls, dictionaries }
}

/** Build a workspace whose `.persona/` holds the given archives. */
function workspace(archives) {
  const root = mkdtempSync(join(tmpdir(), 'persona-picker-'))
  mkdirSync(join(root, '.persona'), { recursive: true })
  for (const [name, frontmatter] of Object.entries(archives)) {
    if (frontmatter === null) { mkdirSync(join(root, '.persona', name), { recursive: true }); continue }
    mkdirSync(join(root, '.persona', name), { recursive: true })
    writeFileSync(join(root, '.persona', name, 'PERSONA.md'), `---\n${frontmatter}\n---\n\n## Layer 1\n`, 'utf8')
  }
  return root
}

const rowsOf = async (mounted, sessionId = 'session-a') =>
  mounted.contribution.ui.options({ sessionId }, new AbortController().signal)

test('picker lists only workspace archives that hold PERSONA.md', async () => {
  const root = workspace({
    alice: 'name: alice\ndescription: first',
    bob: 'name: bob\ndescription: second',
    broken: null,                       // directory without PERSONA.md
  })
  // Library infrastructure and a stray file must never become rows.
  mkdirSync(join(root, '.persona', '.bindings'), { recursive: true })
  mkdirSync(join(root, '.persona', '.routes'), { recursive: true })
  writeFileSync(join(root, '.persona', 'notes.txt'), 'not an archive', 'utf8')
  mkdirSync(join(root, '.persona', 'two words'), { recursive: true })
  writeFileSync(join(root, '.persona', 'two words', 'PERSONA.md'), '---\nname: two words\n---\n', 'utf8')

  const mounted = mount(root)
  const rows = await rowsOf(mounted)
  const library = rows.filter(row => row.group.name === 'library')

  assert.deepEqual(library.map(row => row.label), ['alice', 'bob'])
  assert.deepEqual(library.map(row => row.detail), ['first', 'second'])
  // The infrastructure directories are skipped before any read is spent on them.
  assert.equal(mounted.calls.some(([, path]) => path.includes('.bindings/PERSONA.md')), false)
  assert.equal(mounted.calls.some(([, path]) => path.includes('.routes/PERSONA.md')), false)
})

test('picker marks the session-bound persona active from the ledger', async () => {
  const root = workspace({ alice: 'name: alice\ndescription: first', bob: 'name: bob\ndescription: second' })
  mkdirSync(join(root, '.persona', '.bindings'), { recursive: true })
  writeFileSync(join(root, '.persona', '.bindings', 'session-a.json'), '{"name":"bob"}', 'utf8')

  const rows = await rowsOf(mount(root))
  const active = rows.filter(row => row.active === true)
  assert.deepEqual(active.map(row => row.label), ['bob'])
  // A different session has no ledger entry, so nothing is marked.
  const other = await rowsOf(mount(root), 'session-b')
  assert.equal(other.some(row => row.active === true), false)
})

test('a spawned CHILD session badges its persona end to end (host spawn → ledger → picker)', async () => {
  const root = workspace({ deepseek: 'name: deepseek\ndescription: 大肥鱼' })
  // The real host half: `/persona spawn` against a recording subagent service.
  const spawned = []
  const command = { handler: undefined }
  registerCommands(
    {
      commands: { register: (spec) => { command.handler = spec.handler } },
      subagents: {
        async startContinuable(spec) {
          spawned.push(spec)
          return { childId: spec.childId, messageId: 'msg-1' }
        },
      },
    },
    { libraryDir: '.persona', providerName: 'persona' },
    () => root,
  )
  const parent = {
    id: 'agent-parent',
    ctx: { effect: () => () => {} },
    session: { header: { id: 'session-parent', cwd: root }, id: 'session-parent' },
  }
  const result = await command.handler({ agent: parent, rawInput: 'spawn deepseek' })
  assert.equal(result.kind, 'success', `spawn must succeed, got: ${JSON.stringify(result)}`)
  const childId = spawned[0].childId

  // The child is equipped by construction, so the picker must badge it — and
  // only it: the parent session was never equipped.
  const rows = await rowsOf(mount(root), childId)
  assert.equal(rows.find(row => row.label === 'deepseek').badge, '已装备')
  assert.equal(rows.find(row => row.label === 'deepseek').active, true)
  const parentRows = await rowsOf(mount(root), 'session-parent')
  assert.equal(parentRows.some(row => row.active === true), false)
})

test('picker parses quoted, unquoted and commented descriptions', async () => {
  const root = workspace({
    quoted: 'name: quoted\ndescription: "冷峻的审查者"',
    plain: 'name: plain\ndescription: 温柔的前端专家',
    commented: 'name: commented\ndescription: tuned # not part of the value',
    blank: 'name: blank\ndescription:',
    absent: 'name: absent',
  })
  const rows = await rowsOf(mount(root))
  const detail = Object.fromEntries(rows.filter(r => r.group.name === 'library').map(r => [r.label, r.detail]))
  assert.equal(detail.quoted, '冷峻的审查者')
  assert.equal(detail.plain, '温柔的前端专家')
  assert.equal(detail.commented, 'tuned')
  assert.equal(detail.blank, '（无描述）')
  assert.equal(detail.absent, '（无描述）')
})

test('picker degrades to the action rows when the library or the remote is absent', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'persona-empty-'))
  const missing = await rowsOf(mount(empty))
  // No archives: the status view plus the argument-free actions remain.
  assert.deepEqual(missing.map(row => row.id), ['action:status', 'action:off', 'action:new', 'action:newExample'])
  assert.equal(missing.every(row => row.group.name === 'actions'), true)
  assert.equal(missing[0].detail, '本会话未装备人格 · 库内 0 个人格')

  // A carrier failure on the listing is not an exception: the popup still opens.
  const failed = await rowsOf(mount(empty, { failList: true }))
  assert.deepEqual(failed.map(row => row.id), ['action:status', 'action:off', 'action:new', 'action:newExample'])
})

test('selecting a persona runs the host command for it', async () => {
  const root = workspace({ alice: 'name: alice\ndescription: first' })
  const mounted = mount(root)
  const rows = await rowsOf(mounted)

  await mounted.contribution.ui.onSelect(rows.find(row => row.id === 'use:alice'), { sessionId: 'session-a' })
  assert.deepEqual(mounted.executed, ['/persona use alice'])

  await mounted.contribution.ui.onSelect(rows.find(row => row.id === 'action:off'), { sessionId: 'session-a' })
  assert.deepEqual(mounted.executed, ['/persona use alice', '/persona off'])

  // The example row carries a fixed host line — no free text to collect.
  await mounted.contribution.ui.onSelect(rows.find(row => row.id === 'action:newExample'), { sessionId: 'session-a' })
  assert.deepEqual(mounted.executed, ['/persona use alice', '/persona off', '/persona new --from deepseek'])

  await assert.rejects(
    () => mounted.contribution.ui.onSelect({ id: 'unknown' }, { sessionId: 'session-a' }),
    /没有匹配的人格/,
  )
})

test('every persona offers its own spawn and compact without typing a name', async () => {
  const root = workspace({ alice: 'name: alice\ndescription: first', bob: 'name: bob\ndescription: second' })
  const mounted = mount(root)
  const rows = await rowsOf(mounted)

  const spawn = rows.find(row => row.id === 'spawn:bob')
  const compact = rows.find(row => row.id === 'compact:bob')
  assert.equal(spawn.label, '派生「bob」')
  assert.equal(compact.label, '压缩「bob」的记忆')

  await mounted.contribution.ui.onSelect(spawn, { sessionId: 'session-a' })
  await mounted.contribution.ui.onSelect(compact, { sessionId: 'session-a' })
  assert.deepEqual(mounted.executed, ['/persona spawn bob', '/persona compact bob'])
})

test('list and status are panel views, never flow-node commands', async () => {
  const root = workspace({ alice: 'name: alice\ndescription: first', bob: 'name: bob\ndescription: second' })
  mkdirSync(join(root, '.persona', '.bindings'), { recursive: true })
  writeFileSync(join(root, '.persona', '.bindings', 'session-a.json'), '{"name":"alice"}', 'utf8')

  const mounted = mount(root)
  const rows = await rowsOf(mounted)

  // The whole library is visible as rows, so no /persona list command exists.
  assert.deepEqual(
    rows.filter(row => row.group.name === 'library').map(row => row.label),
    ['alice', 'bob'],
  )
  // The bound persona is marked, and the status row reports it with the count.
  const status = rows.find(row => row.id === 'action:status')
  assert.equal(status.detail, '已装备「alice」 · 库内 2 个人格')
  assert.equal(rows.find(row => row.label === 'alice').badge, '已装备')
  assert.equal(rows.some(row => row.id === 'action:list'), false)

  // Nothing the panel already shows is submitted as a command.
  await mounted.contribution.ui.onSelect(status, { sessionId: 'session-a' })
  assert.deepEqual(mounted.executed, [])
})

test('the create row hands the free-text flow to the agent instead of gating it', async () => {
  const mounted = mount(workspace({ alice: 'name: alice\ndescription: first' }))
  const rows = await rowsOf(mounted)

  const create = rows.find(row => row.id === 'action:new')
  // A popup shell cannot collect a persona name, but the row no longer blocks
  // on that: there is no confirmation gate to acknowledge at all.
  assert.equal('confirmation' in create, false)
  assert.equal(create.detail, '由 agent 引导创建：提供要求或粘贴人设资料')

  // Picking it submits ONE queued kickoff message naming the authoring skill —
  // never a host command line for a name nobody collected.
  await mounted.contribution.ui.onSelect(create, { sessionId: 'session-a' })
  assert.deepEqual(mounted.executed, [])
  assert.equal(mounted.submitted.length, 1)
  assert.equal(mounted.submitted[0].mode, 'queue')
  assert.deepEqual(mounted.submitted[0].content.map(part => part.type), ['text'])
  const kickoff = mounted.submitted[0].content[0].text
  assert.equal(kickoff, mounted.dictionaries.get('persona').zh['prompt.new'])
  assert.match(kickoff, /persona-authoring/)
  assert.match(kickoff, /persona_save/)

  // The rows whose arguments are already known still execute for real.
  await mounted.contribution.ui.onSelect(rows.find(row => row.id === 'action:off'), { sessionId: 'session-a' })
  assert.deepEqual(mounted.executed, ['/persona off'])
})

test('a kickoff that cannot be submitted surfaces the failure instead of swallowing it', async () => {
  // An unretained session has no face to prompt: the row reports that, and
  // submits nothing anywhere.
  const unretained = mount(workspace({}), { noBinding: true })
  const rows = await rowsOf(unretained)
  const create = rows.find(row => row.id === 'action:new')
  await assert.rejects(
    () => unretained.contribution.ui.onSelect(create, { sessionId: 'session-a' }),
    /本会话尚未保留/,
  )
  assert.deepEqual(unretained.executed, [])
  assert.deepEqual(unretained.submitted, [])

  // A rejected prompt propagates the carrier's own error to the picker.
  const rejected = mount(workspace({}), { failPrompt: true })
  await assert.rejects(
    () => rejected.contribution.ui.onSelect(create, { sessionId: 'session-a' }),
    /session is busy/,
  )
  assert.equal(rejected.submitted.length, 1)
  assert.deepEqual(rejected.executed, [])
})

test('the picker copy no longer sends the user to the /persona new command line', async () => {
  const mounted = mount(workspace({}))
  const labels = mounted.contribution.ui.searchLabels()
  // Assert the PROPERTY, not a copy of the string. Hard-coding the value here
  // would only restate the dictionary — it could never fail for a behavioural
  // reason, and it breaks on every legitimate copy edit.
  assert.equal(labels.empty.includes('/persona new'), false)
  assert.equal(labels.noResults.includes('/persona new'), false)

  const create = (await rowsOf(mounted)).find(row => row.id === 'action:new')
  assert.equal(create.detail.includes('/persona new'), false)
  // The gate copy is gone from the dictionary, not merely unreferenced.
  const dicts = mounted.dictionaries.get('persona')
  for (const key of [...Object.keys(dicts.zh), ...Object.keys(dicts.en)]) {
    assert.equal(key.startsWith('gate.new.'), false, `stale dictionary key: ${key}`)
  }
})

test('the contribution carries the localized face and both dictionaries', async () => {
  const mounted = mount(workspace({}))
  const { contribution, dictionaries } = mounted
  assert.equal(contribution.name, 'personas')
  assert.equal(contribution.label(), '人格')
  assert.equal(contribution.description(), '管理持久人格：列表、装备、卸下、新建、派生、压缩')
  assert.equal(typeof contribution.icon, 'function')
  assert.equal(contribution.available({ sessionId: 'session-a' }), true)

  const dicts = dictionaries.get('persona')
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort())
})
