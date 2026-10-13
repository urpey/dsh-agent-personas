import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitFrontmatter, parseYaml } from '../lib/frontmatter.js'
import { createPersona, renderPersonaPrefix, renderPersonaBody, stripPersonaText, listPersonas, libraryRoot } from '../lib/persona.js'
import { readBinding, writeBinding, clearBinding } from '../lib/bindings.js'
import * as mem from '../lib/memory-store.js'
import * as st from '../lib/state-store.js'
import * as criticalPrompts from '../lib/critical-prompts.js'

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

test('turn mode notices: staged critical turn vs one-step routine turn', async () => {
  const { modeNotice, stageTwoPrompt } = await import('../lib/critical-prompts.js')
  const one = modeNotice({ mode: 'one' })
  assert.match(one, /1-step turn/)
  assert.match(one, /No <thinking> block/)
  const two = modeNotice({
    mode: 'staged', mbti: 'INTP', reason: 'keyword "错"',
    state: { palam: { anger: { value: 40 } }, base: { energy: { value: 20, max: 100 } }, relations: { lead: { value: -40 } }, buffs: [{ name: 'adrenaline' }] },
  })
  assert.match(two, /2-step turn/)
  // Step 1 is the monologue alone — the reply is explicitly deferred.
  assert.match(two, /call inner_commit/)
  assert.match(two, /No reply text in this step/)
  // MBTI letters are expanded into tuning hints, not printed raw.
  assert.match(two, /thoughts run inward/)
  assert.match(two, /analytic/)
  // State pressure shows up as concrete hints.
  assert.match(two, /anger is running high \(40\)/)
  assert.match(two, /energy is low \(20\/100\)/)
  assert.match(two, /distrust lead/)
  assert.match(two, /adrenaline/)
  // The state block now rides in the injected context, not a prompt section.
  assert.match(two, /persona context VERBATIM/)
  // Stage 2 is the transform directive handed back by inner_commit.
  const s2 = stageTwoPrompt({ name: 'alice' })
  assert.match(s2, /stage 2 of 2/)
  assert.match(s2, /Output ONLY the reply/)
})

test('frontmatter: trailing comments strip, malformed lines throw', () => {
  // Trailing comments are legal YAML and must not corrupt the value.
  const d = parseYaml('palam:\n  joy: { emit: favor, per: 100, value: 0 }  # 被夸\nkey: 1 # note\nlist:\n  - x  # item note')
  assert.equal(d.palam.joy.value, 0)
  assert.equal(d.palam.joy.emit, 'favor')
  assert.equal(d.key, 1)
  assert.deepEqual(d.list, ['x'])
  // `#` inside quotes is data, not a comment.
  const q = parseYaml('v: "keep #me"')
  assert.equal(q.v, 'keep #me')
  // Malformed lines fail fast instead of silently stringifying.
  assert.throws(() => parseYaml('joy: { a: 1 # oops'), /unterminated/)
  assert.throws(() => parseYaml('joy: { a: 1, b }'), /:/)
  assert.throws(() => parseYaml('just some prose'), /line/)
})

test('commented STATE.md: delta applies, schema keys survive write-back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-comment-'))
  writeFileSync(join(dir, 'STATE.md'), [
    '---',
    'palam:',
    '  joy: { emit: favor, per: 100, decay: 20, value: 0 }  # 被夸、被投喂',
    'relations:',
    '  user: { value: 80 }   # 主人的话永远算数',
    '---',
    '',
  ].join('\n'))
  const r = st.applyDelta(dir, { palam: { joy: 4 }, relations: { user: 8 } })
  assert.equal(r.changed.find(c => c.key === 'joy').after, 4)
  assert.equal(r.changed.find(c => c.key === 'user').after, 88)
  // The deeper hazard: emit/per/decay must survive load→mutate→save,
  // and the operator must be told comments were dropped.
  const d = st.loadState(dir).data
  assert.equal(d.palam.joy.emit, 'favor')
  assert.equal(d.palam.joy.per, 100)
  assert.match(r.notice ?? '', /comment.*dropped/)
})

test('state shape: scalar-corrupted layer entries fail fast at load', () => {
  const cases = [
    ['palam string entry', 'palam:\n  joy: oops\n', /palam\.joy must be a map/],
    ['base scalar entry', 'base:\n  energy: 50\n', /base\.energy must be a map/],
    ['missing emit', 'palam:\n  joy: { per: 100, value: 0 }\n', /emit/],
    ['non-numeric juel', 'juel:\n  favor: soon\n', /juel\.favor must be a number/],
    ['buffs not array', 'buffs: { name: x }\n', /buffs must be an array/],
  ]
  for (const [label, yaml, re] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'persona-bad-'))
    writeFileSync(join(dir, 'STATE.md'), `---\n${yaml}---\n`)
    assert.throws(() => st.loadState(dir), re, label)
  }
})

test('reactions: MBTI defaults compound, declared overrides, render caps', () => {
  const { mergeReactions, renderReactions, assertReactions } = criticalPrompts
  // Opt-in: no MBTI and no declaration means no profile at all.
  assert.deepEqual(mergeReactions('', {}), {})
  // Letters contribute field + multiplier; two letters on one field compound.
  const infp = mergeReactions('INFP', {})
  assert.equal(infp.praise.palam.joy, 1.2 * 1.1 * 1.5)           // I × N × F
  assert.equal(infp.criticism.palam.shame, 1.3 * 1.1 * 1.6)
  assert.equal(infp.praise.relations.user, 1.2)                   // F only
  // A declared event layer replaces the merged one wholesale.
  const declared = mergeReactions('INFP', { praise: { palam: { gluttony: 2 } } })
  assert.equal(declared.praise.palam.gluttony, 2)
  assert.equal(declared.praise.palam.joy, undefined)              // replaced, not merged
  assert.equal(declared.criticism.palam.shame, 1.3 * 1.1 * 1.6)   // other events survive
  // Malformed declarations throw with the offending path.
  assert.throws(() => assertReactions({ praise: { mood: { joy: 1 } } }), /not a writable layer/)
  assert.throws(() => assertReactions({ praise: { palam: { joy: 0 } } }), /positive number/)
  assert.throws(() => assertReactions({ praise: [] }), /map of layer/)
  // Render is one line, rounds float artifacts, and caps the event count.
  assert.match(renderReactions(infp), /criticism→shame×2\.29,anger×0\.7/)
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`e${i}`, { palam: { joy: 1 } }]))
  assert.match(renderReactions(many), /…\+3 more/)
  assert.equal(renderReactions({}), '')
  // The documented authoring shape must survive the real parser: a nested flow
  // map under `reactions:` is where the earlier stringification bug lived.
  const { data: authored } = splitFrontmatter([
    '---', 'mbti: INFP', 'reactions:',
    '  praise: { palam: { joy: 1.5 }, base: { satiety: 0.3 } }',
    '  criticism: { palam: { shame: 1.8 } }', '---', '',
  ].join('\n'))
  const fromFile = mergeReactions(authored.mbti, authored.reactions)
  assert.equal(fromFile.praise.palam.joy, 1.5)                    // declared layer wins
  assert.equal(fromFile.praise.relations.user, 1.2)               // untouched layer keeps F
  assert.equal(fromFile.criticism.palam.shame, 1.8)
})

test('base tick: per-turn drift, clamped, no write when idle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-tick-'))
  writeFileSync(join(dir, 'STATE.md'), [
    '---',
    'base:',
    '  energy:  { max: 100, value: 3, tick: -2 }',
    '  focus:   { max: 100, value: 50 }',
    '  satiety: { max: 100, value: 99, tick: 5 }',
    '---',
    '',
  ].join('\n'))
  // One turn: drains, clamps at max, leaves unticked fields alone.
  assert.deepEqual(st.tickBase(dir).map(d => [d.key, d.after]), [['energy', 1], ['satiety', 100]])
  st.tickBase(dir)
  assert.equal(st.loadState(dir).data.base.energy.value, 0)     // floor at 0
  assert.equal(st.loadState(dir).data.base.satiety.value, 100)  // ceiling at max
  assert.equal(st.loadState(dir).data.base.focus.value, 50)
  // A turn that drifts nothing must not rewrite the file.
  const before = readFileSync(join(dir, 'STATE.md'), 'utf8')
  assert.deepEqual(st.tickBase(dir), [])
  assert.equal(readFileSync(join(dir, 'STATE.md'), 'utf8'), before)
  // A non-numeric tick fails at load, not mid-write.
  writeFileSync(join(dir, 'STATE.md'), '---\nbase:\n  energy: { max: 100, value: 3, tick: fast }\n---\n')
  assert.throws(() => st.loadState(dir), /base\.energy\.tick must be a number/)
})

test('base tick_every: a slow clock keyed to the 1-based turn number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-slow-'))
  writeFileSync(join(dir, 'STATE.md'), [
    '---',
    'base:',
    '  satiety: { max: 100, value: 70, tick: -1, tick_every: 2 }',
    '  energy:  { max: 100, value: 50, tick: -1 }',
    '---',
    '',
  ].join('\n'))
  // Odd turns: only the every-turn field moves.
  assert.deepEqual(st.tickBase(dir, { turn: 1 }).map(d => d.key), ['energy'])
  // Even turn: both move — satiety loses 1 per two turns.
  assert.deepEqual(st.tickBase(dir, { turn: 2 }).map(d => d.key), ['satiety', 'energy'])
  const d = st.loadState(dir).data
  assert.equal(d.base.satiety.value, 69)
  assert.equal(d.base.energy.value, 48)
  // The cadence is visible in the render.
  assert.match(st.renderStateSummary(d), /satiety: 69\/100 \(-1\/2t\)/)
  // Called without a turn number the tick applies immediately (tooling/tests).
  assert.deepEqual(st.tickBase(dir).map(k => k.key), ['satiety', 'energy'])
  // Malformed period fails at load.
  writeFileSync(join(dir, 'STATE.md'), '---\nbase:\n  satiety: { max: 100, value: 70, tick: -1, tick_every: often }\n---\n')
  assert.throws(() => st.loadState(dir), /base\.satiety\.tick_every must be a number/)
})

test('render: tick suffix only when set', () => {
  const data = { base: { energy: { max: 100, value: 40, tick: -1 }, focus: { max: 100, value: 50 } } }
  const line = st.renderStateSummary(data)
  assert.match(line, /energy: 40\/100 \(-1\/t\)/)
  assert.match(line, /focus: 50\/100/)
  assert.doesNotMatch(line, /focus: 50\/100 \(/)
})

test('state_delta event calibration: silent in band, noticed when adrift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-cal-'))
  writeFileSync(join(dir, 'STATE.md'), [
    '---',
    'palam:',
    '  joy: { emit: favor, per: 100, decay: 20, value: 0 }',
    '  shame: { emit: shame, per: 50, decay: 10, value: 0 }',
    'relations:',
    '  user: { value: 0 }',
    '---',
    '',
  ].join('\n'))
  const reactions = { praise: { palam: { joy: 1.5 }, relations: { user: 1.2 } } }
  // In band for the profile (×1.5 → limit 46) → silent.
  const ok = st.applyDelta(dir, { event: 'praise', palam: { joy: 15 }, relations: { user: 2 } }, { reactions })
  assert.equal(ok.notice, undefined)
  assert.equal(st.applyDelta(dir, { event: 'praise', palam: { joy: 40 } }, { reactions }).notice, undefined)
  // Field the event does not map to → noticed as a question, still applied.
  const wrong = st.applyDelta(dir, { event: 'praise', palam: { shame: 10 } }, { reactions })
  assert.match(wrong.notice, /"praise" maps to palam\.joy\/relations\.user; palam\.shame received \+10/)
  assert.equal(st.loadState(dir).data.palam.shame.value, 10)
  // Beyond the profile band → noticed once, never twice for one field.
  const loud = st.applyDelta(dir, { event: 'praise', palam: { joy: 80 } }, { reactions })
  assert.match(loud.notice, /palam\.joy \+80 exceeds the "praise" band \(×1\.5 → ≈±23\)/)
  assert.doesNotMatch(loud.notice, /severe band/)
  // Unknown event name → noticed, delta still applied.
  assert.match(st.applyDelta(dir, { event: 'nonsense', palam: { joy: 1 } }, { reactions }).notice, /no reaction profile/)
  // No event → only the global severe band speaks.
  assert.equal(st.applyDelta(dir, { palam: { joy: 10 } }, { reactions }).notice, undefined)
  assert.match(st.applyDelta(dir, { palam: { joy: 60 } }, { reactions }).notice, /exceeds the severe band/)
  // The profile rides the rendered summary.
  assert.match(st.renderStateSummary(st.loadState(dir).data, { reactions }), /reactions: praise→joy×1\.5,user×1\.2/)
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
