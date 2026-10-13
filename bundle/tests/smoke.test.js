import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
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
  // shame 260, per 50 → +5 juel(shame); decay 10 → remainder 10 + floor(10*0.9)=19
  const r = st.settle(pd)
  assert.equal(r.juelGained.shame, 5)
  assert.equal(st.loadState(pd).data.palam.shame.value, 19)
  assert.equal(st.loadState(pd).data.juel.shame, 5)
  // humiliation requires shame:20 — not yet. give more shame and settle.
  st.applyDelta(pd, { palam: { shame: +950 } })
  const r2 = st.settle(pd)
  // 969/50=19 juel → total 24 ≥20 → humiliation Lv1, juel.shame = 4
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
