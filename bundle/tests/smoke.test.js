import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitFrontmatter } from '../lib/frontmatter.js'
import { createPersona, renderPersonaPrefix, renderPersonaBody, stripPersonaText, listPersonas, libraryRoot } from '../lib/persona.js'
import { readBinding, writeBinding, clearBinding } from '../lib/bindings.js'
import * as mem from '../lib/memory-store.js'
import * as st from '../lib/state-store.js'

const tmp = mkdtempSync(join(tmpdir(), 'persona-'))
const dir = createPersona(tmp, 'alice', 'test persona')
const pd = join(tmp, '.persona', 'alice')

test('persona skeleton exists', () => {
  assert.equal(readFileSync(join(pd, 'PERSONA.md'), 'utf8').includes('alice'), true)
  assert.equal(listPersonas(tmp)[0].name, 'alice')
})

test('memory CRUD + search + alias', () => {
  mem.createNode(pd, 'memory://core/identity', { title: 'identity', content: 'I am alice.', priority: 0, disclosure: 'boot' })
  mem.createNode(pd, 'memory://user/preferences', { content: 'User prefers directness.', disclosure: 'when communicating' })
  const n = mem.readNode(pd, 'memory://core/identity')
  assert.equal(n.content, 'I am alice.')
  assert.equal(n.priority, 0)
  mem.updateNode(pd, 'memory://core/identity', { append: 'I dislike fluff.' })
  assert.equal(mem.readNode(pd, 'memory://core/identity').content.includes('dislike fluff'), true)
  mem.createAlias(pd, 'memory://whoami', 'memory://core/identity')
  assert.equal(mem.readNode(pd, 'memory://whoami').aliasTarget, 'memory://core/identity')
  assert.equal(mem.searchNodes(pd, 'directness').length, 1)
  assert.equal(mem.listNodes(pd).length, 3)
})

test('state delta clamps; palam accumulates', () => {
  const r = st.applyDelta(pd, { base: { energy: +50 }, palam: { shame: +260 }, relations: { lead: +60 } })
  const e = r.changed.find(c => c.key === 'energy')
  assert.equal(e.after, 100)           // clamped to max
  assert.equal(e.clamped, true)
  const s = st.loadState(pd).data
  assert.equal(s.palam.shame.value, 260)
  assert.equal(s.relations.lead.value, 60)
})

test('buff apply/refresh/clear + tick expiry', () => {
  st.applyBuff(pd, { name: 'caffeine', domain: 'physical', duration: 2, deltas: { energy: +10 } })
  st.applyBuff(pd, { name: 'caffeine', domain: 'physical', duration: 5, deltas: { energy: +20 } }) // refresh
  assert.equal(st.loadState(pd).data.buffs.length, 1)
  st.applyBuff(pd, { name: 'wound', deltas: { focus: -15 } })
  assert.equal(st.loadState(pd).data.buffs.length, 2)
  // effective check
  const d = st.loadState(pd).data
  assert.equal(st.effectiveValue(d, 'base', 'energy').effective, 100)  // 100 base +20 buff → clamp 100
  assert.equal(st.effectiveValue(d, 'base', 'focus').effective, 45)    // 60-15
  // ticks: caffeine has duration 5 → after 5 ticks expires
  for (let i = 0; i < 5; i++) st.tickBuffs(pd)
  const names = st.loadState(pd).data.buffs.map(b => b.name)
  assert.deepEqual(names, ['wound'])
  st.clearBuffs(pd, {})
  assert.equal(st.loadState(pd).data.buffs.length, 0)
})

test('settle crystallizes palam → juel → level-up', () => {
  // shame 260, per 50 → +5 juel(shame); remainder 10, decay 10 → floor(10*0.1)=1 kept
  const r = st.settle(pd)
  assert.equal(r.juelGained.shame, 5)
  assert.equal(st.loadState(pd).data.palam.shame.value, 1)
  assert.equal(st.loadState(pd).data.juel.shame, 5)
  // humiliation requires shame:20 — not yet. give more shame and settle.
  st.applyDelta(pd, { palam: { shame: +950 } })
  const r2 = st.settle(pd)
  // 951/50=19 juel → total 24 ≥20 → humiliation Lv1, juel.shame = 4
  const d = st.loadState(pd).data
  assert.equal(d.marks.humiliation.level, 1)
  assert.equal(d.juel.shame, 4)
  assert.equal(r2.levelUps[0].key, 'humiliation')
})

test('session binding ledger round-trips and clears', () => {
  const root = libraryRoot(tmp)
  const sid = 'session-00000000-0000-4000-8000-0000000000ab'
  assert.equal(readBinding(root, sid), undefined)           // absent → undefined
  writeBinding(root, sid, 'alice')
  assert.equal(readBinding(root, sid), 'alice')
  clearBinding(root, sid)
  assert.equal(readBinding(root, sid), undefined)
  clearBinding(root, sid)                                    // clear is idempotent
  assert.equal(readBinding(root, undefined), undefined)      // missing id tolerated
})

test('persona prefix: marker for detection, body for prompt', () => {
  const dir = join(tmp, '.persona', 'alice')
  const prefixed = renderPersonaPrefix(dir, 'alice')
  assert.match(prefixed, /^persona-profile:alice/)
  // Frontmatter must be stripped in both body and prefix text.
  assert.doesNotMatch(prefixed, /^---/m)
  const body = renderPersonaBody(dir, 'alice')
  assert.doesNotMatch(body, /persona-profile:|^---|description:|triggers:/m)
  assert.match(body, /Layer 1|Core Self/)
  // stripPersonaText removes marker + frontmatter from a request.persona payload.
  const stripped = stripPersonaText(prefixed)
  assert.doesNotMatch(stripped, /persona-profile:|^---|description:|triggers:/m)
})

test('memory_update ellipsis patch + title sanitize', () => {
  mem.createNode(tmp, 'memory://a/b', { title: '含 中文&奇怪!字符', content: 'start MIDDLE tail end' })
  const node = mem.readNode(tmp, 'memory://a/b')
  assert.match(node.title, /^[A-Za-z0-9_-]+$/)
  mem.updateNode(tmp, 'memory://a/b', { oldString: 'start...tail', newString: 'REPLACED' })
  assert.match(mem.readNode(tmp, 'memory://a/b').content, /^REPLACED end/)
})

test('critical gate: criticality criteria', async () => {
  const { assessTurn } = await import('../lib/critical.js')
  const st = { palam: { joy: { value: 0 } }, relations: { user: { value: 5 } }, buffs: [] }
  // first contact
  assert.equal(assessTurn({ text: 'hi', state: { relations: {} } }).critical, true)
  // keyword hit
  assert.equal(assessTurn({ text: '这个 bug 是错的，重写', state: st }).critical, true)
  // interest hit
  assert.equal(assessTurn({ text: '聊聊数据库', meta: { interests: ['数据库'] }, state: st }).critical, true)
  // palam pressure
  assert.equal(assessTurn({ text: '随便看看', state: { ...st, palam: { anger: { value: 40 } } } }).critical, true)
  // buff active
  assert.equal(assessTurn({ text: '随便看看', state: { ...st, buffs: [{ name: 'adrenaline' }] } }).critical, true)
  // routine
  assert.equal(assessTurn({ text: '列一下文件', state: st }).critical, false)
})

test('turn mode notices: 1-segment vs 2-segment, single call', async () => {
  const { modeNotice } = await import('../lib/critical-prompts.js')
  const one = modeNotice({ mode: 'one' })
  assert.match(one, /1-segment turn/)
  assert.match(one, /No <thinking> block/)
  const two = modeNotice({
    mode: 'two', mbti: 'INTP', reason: 'keyword "错"',
    state: { palam: { anger: { value: 40 } }, base: { energy: { value: 20, max: 100 } }, relations: { lead: { value: -40 } }, buffs: [{ name: 'adrenaline' }] },
  })
  assert.match(two, /2-segment turn/)
  assert.match(two, /STATE:/)
  // MBTI letters are expanded into tuning hints, not printed raw.
  assert.match(two, /thoughts run inward/)
  assert.match(two, /analytic/)
  // State pressure shows up as concrete hints.
  assert.match(two, /anger is running high \(40\)/)
  assert.match(two, /energy is low \(20\/100\)/)
  assert.match(two, /distrust lead/)
  assert.match(two, /adrenaline/)
  // No structural tool is referenced anymore — one call, two segments.
  assert.doesNotMatch(two, /inner_commit/)
})

test('settle: decay is % of remainder kept — never grows palam', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-settle-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'STATE.md'), [
    '---',
    'palam:',
    '  shame: { emit: shame, per: 50, decay: 10, value: 28 }',
    '  joy: { emit: favor, per: 100, decay: 20, value: 130 }',
    '  fatigue: { emit: fatigue, per: 100, decay: 0, value: 40 }',
    'juel: { shame: 0, favor: 0, fatigue: 0 }',
    '---',
    '',
  ].join('\n'))
  const out = st.settle(dir)
  const after = st.loadState(dir).data
  assert.equal(after.palam.shame.value, 2)     // floor(28 * 0.10)
  assert.equal(after.palam.joy.value, 6)       // floor(30 * 0.20)
  assert.equal(after.palam.fatigue.value, 0)   // decay 0 clears it
  assert.equal(out.juelGained.favor, 1)        // 130 / per 100
  for (const [k, d] of Object.entries(out.palamDelta)) assert.ok(d.after <= d.before, `${k} grew`)
})
