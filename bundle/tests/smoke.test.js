import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitFrontmatter, parseYaml } from '../lib/frontmatter.js'
import { createPersona, renderPersonaPrefix, renderPersonaBody, stripPersonaText, listPersonas, libraryRoot, BUNDLE_ROOT } from '../lib/persona.js'
import { readBinding, writeBinding, clearBinding } from '../lib/bindings.js'
import { appendRoute } from '../lib/route-log.js'
import { equipAgent } from '../lib/equip.js'
import * as mem from '../lib/memory-store.js'
import * as st from '../lib/state-store.js'
import * as criticalPrompts from '../lib/critical-prompts.js'

const tmp = mkdtempSync(join(tmpdir(), 'persona-'))
const dir = createPersona(tmp, 'alice', 'test persona')
const pd = join(tmp, '.persona', 'alice')

/** A plain user turn message, as the harness claims it in a step payload. */
const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

/** Minimal live agent: equip only reaches for session, inject and followup. */
const fakeAgent = (id = 'session-test', sessionExtra = {}) => ({
  session: {
    header: { id },
    id,
    deriveMessages: () => [],
    snapshotEvents: () => [],
    ...sessionExtra,
  },
  inject: () => {}, followup: () => {},
})

/**
 * Minimal agent context for equipAgent: records registered handlers and tools
 * so a test can drive the hooks itself instead of standing up an agent loop.
 */
function fakeAgentCtx() {
  const handlers = { 'agent/pre-step': [], 'agent/turn-stopping': [], 'session/event': [], 'tools/pre-execute': [], 'agent/error': [] }
  const tools = new Map()
  return {
    handlers, tools,
    ctx: {
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      on: (name, fn) => { (handlers[name] ??= []).push(fn); return () => {} },
      tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
      logger: { warn: () => {} },
    },
  }
}

/** Drive equip's pre-step listener the way the harness does. */
async function runPreStep(fake, payload) {
  const handler = fake.handlers['agent/pre-step'][0]
  return handler(payload, async () => ({ kind: 'enter', messages: [] }))
}

/** All text a pre-step decision injected, as one string for regex assertions. */
const injectedText = (decision) => (decision.messages ?? [])
  .flatMap(m => (m.content ?? []).map(b => b.text ?? '')).join('\n')

/** The routes file a session's verdicts land in, under the `.persona/` root. */
const routesFile = (sid) => join(libraryRoot(tmp), '.routes', `${sid}.jsonl`)
const lastRoute = (sid) => JSON.parse(readFileSync(routesFile(sid), 'utf8').trim().split('\n').pop())

test('persona skeleton exists', () => {
  assert.equal(readFileSync(join(pd, 'PERSONA.md'), 'utf8').includes('alice'), true)
  assert.equal(listPersonas(tmp)[0].name, 'alice')
})

test('PERSONA template: Layer 2 carries the examples contract', () => {
  // The few-shot block is authored prose, so only the template can carry it —
  // there is no runtime code path to assert. What must not regress: the field
  // exists, it is declared baseline (STATE re-tunes), and it is declared
  // absorb-not-reuse so a persona does not recite its own examples.
  const tpl = readFileSync(join(BUNDLE_ROOT, 'templates', 'PERSONA.md'), 'utf8')
  assert.match(tpl, /- \*\*examples\*\*: 3–5 labeled pairs/)
  assert.match(tpl, /BASELINE voice — `STATE\.md` re-tunes it/)
  assert.match(tpl, /Patterns to absorb, never lines to reuse/)
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

test('state delta clamps; juel accumulates', () => {
  const r = st.applyDelta(pd, { base: { energy: +50 }, juel: { shame: +260 }, relations: { lead: +60 } })
  const e = r.changed.find(c => c.key === 'energy')
  assert.equal(e.after, 100)           // clamped to max
  assert.equal(e.clamped, true)
  const s = st.loadState(pd).data
  assert.equal(s.juel.shame.value, 260)
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

test('settle crystallizes juel → param → level-up', () => {
  // shame 260, per 50 → +5 param(intimacy); remainder 10, decay 10 → floor(10*0.1)=1 kept
  const r = st.settle(pd)
  assert.equal(r.paramMoved.intimacy, 5)
  assert.equal(st.loadState(pd).data.juel.shame.value, 1)
  assert.equal(st.loadState(pd).data.param.intimacy, 5)
  // guarded requires wariness:20 — not yet. give fear and settle.
  st.applyDelta(pd, { juel: { fear: +950 } })
  const r2 = st.settle(pd)
  // 950/100=9 param(wariness) — below 20, no level-up yet
  assert.equal(r2.paramMoved.wariness, 9)
  assert.equal(st.loadState(pd).data.param.wariness, 9)
  st.applyDelta(pd, { juel: { fear: +1200 } })
  const r3 = st.settle(pd)
  // wariness total 9+12=21 ≥20 → guarded Lv1, param.wariness = 1
  const d = st.loadState(pd).data
  assert.equal(d.marks.guarded.level, 1)
  assert.equal(d.param.wariness, 1)
  assert.equal(r3.levelUps[0].key, 'guarded')
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

test('gate prompts: imperative, signals, stage-1 directive', () => {
  const { gateInstruction, signalsLine, stageOnePrompt, stageTwoPrompt, REPLY_DIRECTIVE,
          GATE_ACK_CRITICAL, GATE_ACK_ROUTINE } = criticalPrompts
  // The verdict step orders ONE call and nothing else.
  const gate = gateInstruction({ signals: signalsLine({ state: { relations: {} }, text: 'hi' }) })
  assert.match(gate, /persona gate/)
  assert.match(gate, /persona_gate\(\{ critical/)
  assert.match(gate, /no reply text/)
  assert.match(gate, /first contact/)
  // Forced modes still route through the tool, so there is one code path.
  assert.match(gateInstruction({ forced: 'always' }), /forced CRITICAL/)
  assert.match(gateInstruction({ forced: 'never' }), /forced ROUTINE/)
  assert.doesNotMatch(gateInstruction({}), /forced/)
  // Signals: deterministic facts only, and the first-contact line always exists.
  assert.match(signalsLine({ state: { relations: {} } }), /first contact/)
  const sig = signalsLine({
    state: { juel: { anger: { value: 40 } }, buffs: [{ name: 'adrenaline' }] },
    meta: { interests: ['饭'] },
    text: 'hi',
  })
  assert.match(sig, /anger = 40/)
  assert.match(sig, /adrenaline/)
  assert.match(sig, /饭/)
  assert.match(sig, /input: "hi"/)
  assert.match(signalsLine({}), /first contact/)          // never ''
  assert.match(signalsLine({ state: { relations: { user: { value: 80 } } } }), /speaker: known \(relations user=80\)/)
  // Stage 1 is the monologue alone — the reply is explicitly deferred.
  const one = stageOnePrompt({
    name: 'alice', mbti: 'INTP', reason: 'the 圆 word landed',
    state: { juel: { anger: { value: 40 } }, base: { energy: { value: 20, max: 100 } }, relations: { lead: { value: -40 } }, buffs: [{ name: 'adrenaline' }] },
  })
  assert.match(one, /stage 1 of 2/)
  assert.match(one, /the 圆 word landed/)
  assert.match(one, /call inner_commit/)
  assert.match(one, /No reply text in this step/)
  // MBTI letters are expanded into tuning hints, not printed raw.
  assert.match(one, /thoughts run inward/)
  assert.match(one, /analytic/)
  // State pressure shows up as concrete hints.
  assert.match(one, /anger is running high \(40\)/)
  assert.match(one, /energy is low \(20\/100\)/)
  // Relations speak through the stance band, which covers every value — not
  // only the extremes the old rule bothered to name.
  assert.match(one, /lead: hostile \(-40\) — suspicion first/)
  assert.match(one, /adrenaline/)
  // The state block now rides in the injected context, not a prompt section.
  assert.match(one, /persona context VERBATIM/)
  // An omitted reason renders without the line rather than as "undefined".
  assert.doesNotMatch(stageOnePrompt({ name: 'alice' }), /in your words/)
  // Stage 2 is the transform directive handed back by inner_commit.
  const s2 = stageTwoPrompt({ name: 'alice' })
  assert.match(s2, /stage 2 of 2/)
  assert.match(s2, /Output ONLY the reply/)
  // Voice precedence rides the transform: persona+state set tone; memory/context
  // set content truthfulness and only shade the voice.
  assert.match(s2, /first reference for how you sound/)
  assert.match(s2, /content truthfulness/)
  // The stage-1 CHOICE line carries the same precedence into the monologue.
  assert.match(one, /CHOICE: .*first reference/)
  // The routine shape and the two verdict acks.
  assert.match(REPLY_DIRECTIVE, /No <thinking> block/)
  assert.match(REPLY_DIRECTIVE, /routine/)
  // Voice precedence rides the routine directive too.
  assert.match(REPLY_DIRECTIVE, /first reference for tone/)
  assert.match(REPLY_DIRECTIVE, /content truthfulness/)
  assert.match(GATE_ACK_CRITICAL, /critical/)
  assert.match(GATE_ACK_ROUTINE, /routine/)
  // The mode notice is gone: the model rules the shape, code does not.
  assert.equal('modeNotice' in criticalPrompts, false)
})

test('quick pass: the gate carries perceive + aim, and EXPECT rules the verdict', () => {
  const { gateInstruction, MONOLOGUE_LABELS } = criticalPrompts
  const gate = gateInstruction({ signals: '- speaker: first contact — no relation record yet' })
  // The three quick-pass questions are asked before the verdict.
  assert.match(gate, /PERCEIVE: what is actually happening/)
  assert.match(gate, /AIM: what does this reply need to achieve/)
  assert.match(gate, /EXPECT: if you answered on reflex/)
  // The call carries both fields, so the quick pass is recorded, not implied.
  assert.match(gate, /persona_gate\(\{ critical: true\|false, perceive: "<what is happening>", aim: "<what this reply must achieve>"/)
  // The semantic contract: routine = terminal cognition, critical = sketch.
  assert.match(gate, /on a routine turn\s+they are the whole of this turn's thinking/)
  assert.match(gate, /on a critical turn they are the\s+sketch the monologue deepens and may overrule/)
  // Forced modes still ask for the quick pass — a forced verdict is not a
  // licence to skip thinking.
  assert.match(gateInstruction({ forced: 'always' }), /PERCEIVE: what is actually happening/)
  // WANT is deliberately NOT a gate output: it lives in the monologue only.
  assert.doesNotMatch(gate, /persona_gate\(\{[^)]*want/)
  assert.equal(MONOLOGUE_LABELS.includes('WANT'), true)
})

test('deep pass: the monologue opens with STATE + the seven aspects, in order', () => {
  const { stageOnePrompt, MONOLOGUE_LABELS } = criticalPrompts
  const one = stageOnePrompt({ name: 'alice', mbti: 'INTP', state: {} })
  // Eight labeled lines, seven aspects, canonical order.
  assert.deepEqual(MONOLOGUE_LABELS, ['STATE', 'PERCEIVE', 'AIM', 'WANT', 'WEIGH', 'EXPECT', 'CHOICE', 'REASON'])
  assert.match(one, /eight labeled lines/)
  for (const label of MONOLOGUE_LABELS) assert.match(one, new RegExp(`^${label}: `, 'm'), `${label} line missing`)
  // Order is the contract, not just presence.
  const positions = MONOLOGUE_LABELS.map(l => one.indexOf(`\n${l}: `))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  // The retired labels are absorbed, not kept as extra lines.
  for (const dead of ['TRIGGERS:', 'REFUSAL:', 'VOICE:']) assert.doesNotMatch(one, new RegExp(`^${dead}`, 'm'))
  // Responsibilities survive the merge: triggers under PERCEIVE, the refusal
  // under WEIGH, tone/length under CHOICE.
  assert.match(one, /PERCEIVE: .*what it touches \(values, wounds, stored memories\)/)
  assert.match(one, /WEIGH: .*what you will NOT say goes here/)
  assert.match(one, /CHOICE: .*tone \+ length/)
  // The quick pass is already in the conversation — nothing is re-embedded, and
  // the sketch is explicitly overrulable.
  assert.match(one, /The quick pass you ruled on is in this conversation/)
  assert.match(one, /you may overrule the sketch/)
  // A thin block still commits.
  assert.match(one, /A block that skips aspects still commits/)
})

test('monologue label check is soft: missing labels ride the stage-2 directive', () => {
  const { missingMonologueLabels, stageTwoPrompt } = criticalPrompts
  const full = ['STATE', 'PERCEIVE', 'AIM', 'WANT', 'WEIGH', 'EXPECT', 'CHOICE', 'REASON']
    .map(l => `${l}: x`).join('\n')
  assert.deepEqual(missingMonologueLabels(full), [])
  // Partial: only the absent ones are named, in canonical order.
  assert.deepEqual(missingMonologueLabels('STATE: x\nPERCEIVE: y\nCHOICE: z'), ['AIM', 'WANT', 'WEIGH', 'EXPECT', 'REASON'])
  // Indented labels count — models indent inside a block.
  assert.deepEqual(missingMonologueLabels('  STATE: x\n  PERCEIVE: y\n  AIM: a\n  WANT: b\n  WEIGH: c\n  EXPECT: d\n  CHOICE: e\n  REASON: f'), [])
  // A label mentioned mid-sentence is not a labeled line.
  assert.equal(missingMonologueLabels('I should WEIGH this later').includes('WEIGH'), true)
  // Empty monologue (log unreadable) reports nothing to fix — no false alarm.
  assert.deepEqual(missingMonologueLabels(''), ['STATE', 'PERCEIVE', 'AIM', 'WANT', 'WEIGH', 'EXPECT', 'CHOICE', 'REASON'])
  // The notice is appended, singular/plural correct, and absent when complete.
  const thin = stageTwoPrompt({ name: 'alice', monologue: 'STATE: x', missing: ['WANT'] })
  assert.match(thin, /Your monologue skipped WANT — the reply still has to answer it\./)
  const two = stageTwoPrompt({ name: 'alice', monologue: 'STATE: x', missing: ['WANT', 'WEIGH'] })
  assert.match(two, /skipped WANT, WEIGH — the reply still has to answer them\./)
  assert.doesNotMatch(stageTwoPrompt({ name: 'alice', monologue: full }), /skipped/)
})

test('relation stance: every value has a band, zero included', () => {
  const { relationStance, RELATION_BANDS } = criticalPrompts
  assert.equal(relationStance(-40).label, 'hostile')
  assert.equal(relationStance(-5).label, 'cold')
  // The value that most needs saying out loud: the old rule was silent here,
  // so the persona's Layer-1 prose ("主人·几乎写死的高") won by default.
  assert.equal(relationStance(0).label, 'unbonded')
  assert.equal(relationStance(29).label, 'unbonded')
  assert.equal(relationStance(30).label, 'warm')
  assert.equal(relationStance(80).label, 'bonded')
  // Total by construction: an unreadable value must not produce a hole.
  assert.equal(relationStance(undefined).label, 'unbonded')
  assert.equal(relationStance('nonsense').label, 'unbonded')
  assert.equal(RELATION_BANDS[RELATION_BANDS.length - 1].max, Infinity)
})

test('signals: stance for every relation, carried param flagged', () => {
  const { signalsLine } = criticalPrompts
  const sig = signalsLine({ state: { relations: { user: { value: 0 } }, param: { defiance: 60 } } })
  // The numeric speaker line is unchanged — the stance rides beside it.
  assert.match(sig, /- speaker: known \(relations user=0\)/)
  assert.match(sig, /- stance toward user: unbonded \(0\) — no standing yet — do not presume closeness/)
  // Crystallized weight is not mood; it gets its own line so the gate sees it.
  assert.match(sig, /- carried \(standing, not this turn's mood\): defiance = 60/)
  // A small balance stays out of the signal block — no noise for pocket change.
  assert.doesNotMatch(signalsLine({ state: { param: { affection: 5 } } }), /carried/)
})

test('state rules: a zero relation, a kept defiance, and banked amends reach the monologue', () => {
  const { stageOnePrompt } = criticalPrompts
  assert.match(
    stageOnePrompt({ name: 'alice', state: { relations: { user: { value: 0 } } } }),
    /user: unbonded \(0\) — no standing yet/)
  assert.match(
    stageOnePrompt({ name: 'alice', state: { param: { defiance: 60 } } }),
    /defiance is carried \(60\) — settled standing, not this turn's mood/)
  // A banked negative juel is amends waiting to burn standing on settle.
  assert.match(
    stageOnePrompt({ name: 'alice', state: { juel: { anger: { value: -30 } } } }),
    /anger is banked low \(-30\) — amends\/counterweight/)
  // The flat fallback still exists for a persona with nothing declared.
  assert.match(stageOnePrompt({ name: 'alice' }), /state is flat/)
})

test('render: relations carry their stance, param is labelled standing', () => {
  const out = st.renderStateSummary({
    relations: { user: { value: 0 } },
    param: { defiance: 60 },
  })
  assert.match(out, /relations: user \+0 \(unbonded — no standing yet — do not presume closeness\)/)
  assert.match(out, /param \(standing, settle-only\): defiance×60/)
})

test('route log: append-only JSONL sidecar, hostile ids contained', () => {
  const sid = 'session-00000000-0000-4000-8000-0000000000ab'
  const p = appendRoute(tmp, sid, {
    at: '2026-10-11T12:00:00+08:00', turn: 1, step: 1,
    verdict: 'critical', reason: 'the 圆 word landed', signals: '- speaker: known',
  })
  assert.match(p, /\.routes\/session-00000000-0000-4000-8000-0000000000ab\.jsonl$/)
  const line = JSON.parse(readFileSync(p, 'utf8').trim())
  assert.equal(line.verdict, 'critical')
  assert.equal(line.reason, 'the 圆 word landed')
  // Second append is a new line, not a rewrite.
  appendRoute(tmp, sid, { verdict: 'routine' })
  assert.equal(readFileSync(p, 'utf8').trim().split('\n').length, 2)
  // Hostile session id cannot escape the routes dir.
  const q = appendRoute(tmp, '../../escape', { verdict: 'routine' })
  assert.equal(q.includes('..'), false)
  // Missing id is tolerated.
  assert.match(appendRoute(tmp, undefined, { verdict: 'routine' }), /unknown\.jsonl$/)
  // The sanitizer stays total: a dot-only id is still a filename.
  assert.match(appendRoute(tmp, '...', { verdict: 'routine' }), /unknown\.jsonl$/)
  // The dir may be wiped between turns — every append re-creates it.
  rmSync(join(tmp, '.routes'), { recursive: true, force: true })
  assert.match(appendRoute(tmp, sid, { verdict: 'missed' }), /\.routes\//)
  // An unwritable root degrades to undefined instead of breaking a turn.
  assert.equal(appendRoute(join(pd, 'PERSONA.md', 'nope'), 'x', { verdict: 'routine' }), undefined)
})

test('equip gate step: the turn opens with the imperative', async () => {
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, fakeAgent('session-gate'), pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  const decision = await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('hi')] })
  const text = injectedText(decision)
  assert.match(text, /persona gate/)
  assert.match(text, /persona_gate/)
  // The input was read from the payload, not the terminal decision — a plain
  // user message must survive latestText's runtime-snapshot filter.
  assert.match(text, /input: "hi"/)
})

test('equip routine verdict: the reply directive arrives at the next step', async () => {
  const agent = fakeAgent('session-routine')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('列一下文件')] })
  const ack = await fake.tools.get('persona_gate').execute(
    { critical: false, perceive: '主人要我列文件', aim: '给一份清单', reason: 'small talk' }, { agent })
  assert.match(ack, /routine/)
  const next = await runPreStep(fake, { turn: 1, step: 2, messages: [] })
  assert.match(injectedText(next), /No <thinking> block/)
  // Injected once: a later step in the same turn does not re-issue it.
  const later = await runPreStep(fake, { turn: 1, step: 3, messages: [] })
  assert.doesNotMatch(injectedText(later), /No <thinking> block/)
  const line = lastRoute('session-routine')
  assert.equal(line.verdict, 'routine')
  // The quick pass is on the record: on a routine turn it IS the thinking.
  assert.equal(line.perceive, '主人要我列文件')
  assert.equal(line.aim, '给一份清单')
  assert.deepEqual(Object.keys(line).sort(), ['aim', 'at', 'perceive', 'reason', 'signals', 'step', 'turn', 'verdict'])
})

test('equip critical verdict: stage 1 carries the model reason, the log records it', async () => {
  const agent = fakeAgent('session-critical')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('你这几天都不理我')] })
  const ack = await fake.tools.get('persona_gate').execute({ critical: true, reason: 'the 圆 word landed' }, { agent })
  assert.match(ack, /critical/)
  const next = await runPreStep(fake, { turn: 1, step: 2, messages: [] })
  const text = injectedText(next)
  assert.match(text, /stage 1 of 2/)
  assert.match(text, /the 圆 word landed/)
  // The verdict lands in the sidecar log — the spec's full entry shape, not
  // just the verdict, so a reader can reconstruct what the ruling saw.
  const line = lastRoute('session-critical')
  assert.equal(line.verdict, 'critical')
  assert.equal(line.reason, 'the 圆 word landed')
  // No quick pass written → the log omits the fields rather than logging empty
  // strings, so a pre-existing line and a thin one keep the same base shape.
  assert.deepEqual(Object.keys(line).sort(), ['at', 'reason', 'signals', 'step', 'turn', 'verdict'])
  assert.equal(line.turn, 1)
  assert.match(line.signals, /input: "你这几天都不理我"/)
})

test('inner_commit: the monologue rides stage 2, and a thin block is reported not rejected', async () => {
  const agent = fakeAgent('session-stage2')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('你这几天都不理我')] })
  await fake.tools.get('persona_gate').execute({ critical: true, reason: 'loaded' }, { agent })
  // The monologue is written as a literal <thinking> span; the stream transform
  // turns it into a reasoning block, and request history strips that block — so
  // inner_commit re-reads the raw log to carry it into stage 2.
  const monologue = 'STATE: energy 20/100\nPERCEIVE: 主人说我几天不理他\nAIM: 让他知道我在\nCHOICE: 短、承认、不辩解\nREASON: 我在乎'
  agent.session.snapshotEvents = () => ([
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: monologue }] } } },
  ])
  const directive = await fake.tools.get('inner_commit').execute({}, { agent })
  assert.match(directive, /stage 2 of 2/)
  assert.match(directive, /the reader cannot see it/)
  assert.match(directive, /PERCEIVE: 主人说我几天不理他/)
  // Soft check: WANT, WEIGH and EXPECT were skipped, so the transform is told
  // to answer them — the commit itself still succeeds and stage 2 still renders.
  assert.match(directive, /Your monologue skipped WANT, WEIGH, EXPECT — the reply still has to answer them\./)
  assert.match(directive, /Output ONLY the reply/)
})

test('inner_commit: a complete monologue carries no skip notice', async () => {
  const agent = fakeAgent('session-stage2-full')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('hi')] })
  await fake.tools.get('persona_gate').execute({ critical: true, reason: 'loaded' }, { agent })
  const full = ['STATE', 'PERCEIVE', 'AIM', 'WANT', 'WEIGH', 'EXPECT', 'CHOICE', 'REASON']
    .map(l => `${l}: x`).join('\n')
  agent.session.snapshotEvents = () => ([
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: full }] } } },
  ])
  const directive = await fake.tools.get('inner_commit').execute({}, { agent })
  assert.doesNotMatch(directive, /skipped/)
  assert.match(directive, /STATE: x/)
})

test('equip missed verdict: a turn that never ruled is logged, not interrupted', async () => {
  const agent = fakeAgent('session-missed')
  const followed = []
  agent.followup = (m) => followed.push(m)
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  // The model answers without ruling; the turn is left intact.
  await runPreStep(fake, { turn: 2, step: 1, messages: [userMessage('hi')] })
  fake.handlers['agent/turn-stopping'][0]({ agent })
  const line = lastRoute('session-missed')
  assert.equal(line.verdict, 'missed')
  assert.equal(line.turn, 2)
  assert.equal(followed.length, 0)
})

test('equip gate ledger: the verdict carries the delta, the log records it', async () => {
  const bob = createPersona(tmp, 'bob', 'ledger persona')
  const agent = fakeAgent('session-ledger')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, bob, 'bob',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('你这肥鱼')] })
  const ack = await fake.tools.get('persona_gate').execute(
    { critical: false, reason: 'small talk', delta: { juel: { anger: +12 }, event: 'insult' } }, { agent })
  assert.match(ack, /routine/)
  // The ledger rides the same write channel as state_delta — calibration notice
  // included, in the result the model already reads.
  assert.match(ack, /no reaction profile/)
  assert.equal(st.loadState(bob).data.juel.anger.value, 12)
  const line = lastRoute('session-ledger')
  assert.equal(line.verdict, 'routine')
  assert.equal(line.delta[0].key, 'anger')
  assert.equal(line.delta[0].after, 12)
  // The next step's state block already shows what the verdict recorded.
  const next = await runPreStep(fake, { turn: 1, step: 2, messages: [] })
  assert.match(injectedText(next), /juel: joy 0 · anger 12/)
  // A malformed delta degrades to a notice: the verdict and its directive
  // must survive a bad ledger entry.
  const bad = await fake.tools.get('persona_gate').execute(
    { critical: false, delta: { base: { nope: +5 } } }, { agent })
  assert.match(bad, /routine/)
  assert.match(bad, /delta not applied/)
})

test('equip no-delta ledger: a ruled turn that recorded nothing is logged', async () => {
  const agent = fakeAgent('session-nodelta')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  await runPreStep(fake, { turn: 5, step: 1, messages: [userMessage('在吗')] })
  await fake.tools.get('persona_gate').execute({ critical: false, reason: 'small talk' }, { agent })
  fake.handlers['agent/turn-stopping'][0]({ agent })
  const line = lastRoute('session-nodelta')
  assert.equal(line.verdict, 'no-delta')
  assert.equal(line.turn, 5)
})

test('equip no-delta ledger: a recorded entry suppresses it', async () => {
  const agent = fakeAgent('session-recorded')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  await runPreStep(fake, { turn: 6, step: 1, messages: [userMessage('在吗')] })
  await fake.tools.get('persona_gate').execute({ critical: false, reason: 'x', delta: { juel: { joy: +3 } } }, { agent })
  // A mid-turn state_delta counts too — the ledger belongs to the turn, not to
  // the gate call that usually opens it.
  await fake.tools.get('state_delta').execute({ juel: { joy: +2 } }, { agent })
  fake.handlers['agent/turn-stopping'][0]({ agent })
  assert.equal(lastRoute('session-recorded').verdict, 'routine')
})

test('equip stream hook: <thinking> in text becomes a reasoning block', async () => {
  const agent = fakeAgent('session-tags')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  const listener = fake.handlers['llm/stream'][0]
  assert.equal(typeof listener, 'function')
  // An own-session stream is transformed.
  const source = (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'hi <thinking>inner</thinking> there' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hi <thinking>inner</thinking> there' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const chunks = []
  for await (const c of listener({ sessionId: 'session-tags' }, () => source)) chunks.push(c)
  const ends = chunks.filter(c => c.type === 'block-end').map(c => c.block)
  assert.deepEqual(ends.map(b => b.type), ['text', 'reasoning', 'text'])
  assert.deepEqual(ends.map(b => b.text), ['hi', 'inner', 'there'])
  // Another session's stream is not.
  const foreign = (async function* () {
    yield { type: 'text-delta', index: 0, text: 'raw <thinking>x</thinking>' }
  })()
  const other = []
  for await (const c of listener({ sessionId: 'other-session' }, () => foreign)) other.push(c)
  assert.deepEqual(other, [{ type: 'text-delta', index: 0, text: 'raw <thinking>x</thinking>' }])
})

test('equip deriveMessages wrap: monologue blocks never reach the request', async () => {
  const logged = [
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'tag monologue' },
        { type: 'text', text: 'reply' },
      ],
      source: { kind: 'model', provider: 'p', model: 'm', replayState: { blocks: [{ type: 'reasoning' }, { type: 'text' }] } },
    },
  ]
  const agent = fakeAgent('session-derive', { deriveMessages: () => logged })
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  const derived = agent.session.deriveMessages()
  assert.equal(derived.length, 1)
  assert.deepEqual(derived[0].content, [{ type: 'text', text: 'reply' }])
  assert.deepEqual(derived[0].source.replayState.blocks, [{ type: 'text' }])
})

test('inner_commit carries the monologue to stage 2 through the tool result', async () => {
  const events = [
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: '其实我有点生气' },
            { type: 'tool-call', id: 'c1', name: 'inner_commit', arguments: '{}' },
          ],
        },
      },
    },
  ]
  const agent = fakeAgent('session-commit', { snapshotEvents: () => events })
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  const result = await fake.tools.get('inner_commit').execute({}, { agent })
  assert.match(result, /stage 2 of 2/)
  assert.match(result, /其实我有点生气/)
  assert.match(result, /reader cannot see it/)
})

test('stageTwoPrompt renders without a monologue (degraded)', async () => {
  const s2 = criticalPrompts.stageTwoPrompt({ name: 'alice' })
  assert.doesNotMatch(s2, /inner monologue — the reader/)
  const withMono = criticalPrompts.stageTwoPrompt({ name: 'alice', monologue: 'felt hurt' })
  assert.match(withMono, /felt hurt/)
})

test('equip turn-stopping: a critical turn pays stage 2 unless inner_commit ran', async () => {
  const gateThenStop = async (sid, commit) => {
    const agent = fakeAgent(sid)
    const followed = []
    agent.followup = (m) => followed.push(m)
    const fake = fakeAgentCtx()
    equipAgent(fake.ctx, agent, pd, 'alice',
      { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
    await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('hi')] })
    await fake.tools.get('persona_gate').execute({ critical: true, reason: 'loaded' }, { agent })
    await runPreStep(fake, { turn: 1, step: 2, messages: [] })
    if (commit) await fake.tools.get('inner_commit').execute({}, { agent })
    fake.handlers['agent/turn-stopping'][0]({ agent })
    return followed
  }
  // Monologue emitted but never committed: the reader must not get a bare
  // monologue, so the transform directive is queued as the next turn.
  const uncommitted = await gateThenStop('session-nocommit', false)
  assert.equal(uncommitted.length, 1)
  assert.match(uncommitted[0].content[0].text, /stage 2 of 2/)
  // inner_commit ends stage 1 legitimately — nothing is owed at turn end.
  assert.equal((await gateThenStop('session-committed', true)).length, 0)
})

test('equip turn-stopping: an unconsumed directive is re-queued exactly once', async () => {
  const agent = fakeAgent('session-owed')
  const injected = []
  const followed = []
  agent.inject = (m) => injected.push(m)
  agent.followup = (m) => followed.push(m)
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('hi')] })
  // Verdict ruled, but the turn ends before any step can consume the directive.
  await fake.tools.get('persona_gate').execute({ critical: false, reason: 'small talk' }, { agent })
  fake.handlers['agent/turn-stopping'][0]({ agent })
  // ONE queue call: a non-empty next-step queue is itself what makes the loop
  // re-enter, so a followup here would throw (the inbox rejects a second pending
  // id-less message) or double-deliver if the messages carried ids.
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /No <thinking> block/)
  assert.equal(followed.length, 0)
  // Paid once: a second turn-stopping does not re-queue it.
  fake.handlers['agent/turn-stopping'][0]({ agent })
  assert.equal(injected.length, 1)
})

test('equip gate offered twice: a step-2 user input still gets the imperative', async () => {
  const agent = fakeAgent('session-reask')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  // A turn whose first step goes by without a verdict.
  const first = await runPreStep(fake, { turn: 9, step: 1, messages: [userMessage('hi')] })
  assert.match(injectedText(first), /persona_gate/)
  // A later user-bearing step in the same turn re-offers it once, so a turn whose
  // first step was answered on reflex is still routed.
  const second = await runPreStep(fake, { turn: 9, step: 2, messages: [userMessage('还有这个')] })
  assert.match(injectedText(second), /persona_gate/)
  // ...but not a third time, and not without new user input.
  const third = await runPreStep(fake, { turn: 9, step: 3, messages: [userMessage('还有')] })
  assert.doesNotMatch(injectedText(third), /persona_gate/)
  const fourth = await runPreStep(fake, { turn: 9, step: 4, messages: [] })
  assert.doesNotMatch(injectedText(fourth), /persona_gate/)
})

test('equip miss log: a turn never offered the gate is not a compliance miss', async () => {
  const agent = fakeAgent('session-notasked')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  // A housekeeping turn: no user text at all, so the gate was never offered.
  await runPreStep(fake, { turn: 3, step: 1, messages: [] })
  fake.handlers['agent/turn-stopping'][0]({ agent })
  assert.throws(() => lastRoute('session-notasked'), /ENOENT/)
})

test('equip turn-start notices: buff expiry and a bad reactions table ride one queue call', async () => {
  const bad = mkdtempSync(join(tmpdir(), 'persona-notice-'))
  createPersona(bad, 'bob', 'notice persona')
  const bd = join(bad, '.persona', 'bob')
  writeFileSync(join(bd, 'PERSONA.md'), [
    '---', 'name: bob', 'description: notice persona', 'reactions:',
    '  praise: { mood: { joy: 1 } }', '---', '', '## Layer 1 · Core Self', '- **identity**: bob', '',
  ].join('\n'))
  writeFileSync(join(bd, 'STATE.md'), [
    '---', 'buffs:', '  - { name: caffeine, domain: physical, duration: 1, deltas: { focus: 10 } }', '---', '',
  ].join('\n'))
  const agent = fakeAgent('session-notice')
  const injected = []
  agent.inject = (m) => injected.push(m)
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, bd, 'bob',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  // Both notices are true on turn 1: the buff expires and the table is malformed.
  await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('hi')] })
  // One call, both notices: a second id-less pending message is rejected by the
  // inbox, and at the turn boundary that rejection aborted the whole turn.
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /buffs expired: caffeine/)
  assert.match(injected[0].content[0].text, /reactions ignored/)
})

test('equip immersion watch: the leak correction is delivered at the next step', async () => {
  const agent = fakeAgent('session-leak')
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  // A leak in visible text. Injecting from inside the session's own append throws
  // ("cannot reenter while another append is being published"), so the correction
  // is stored and delivered by the next pre-step instead.
  fake.handlers['session/event'][0](agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'I wrote it to memory://core/x' }] } },
  })
  const decision = await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('hi')] })
  assert.match(injectedText(decision), /persona ooc/)
})

test('equip injected messages are identified: no id-less queue collision', async () => {
  const agent = fakeAgent('session-ids')
  const injected = []
  agent.inject = (m) => injected.push(m)
  const fake = fakeAgentCtx()
  equipAgent(fake.ctx, agent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  // The inbox rejects a duplicate pending id across both lists, so two id-less
  // messages collide and one is dropped. Identified injections cannot.
  const a = await runPreStep(fake, { turn: 41, step: 1, messages: [userMessage('hi')] })
  const b = await runPreStep(fake, { turn: 41, step: 2, messages: [userMessage('还有')] })
  const ids = [...(a.messages ?? []), ...(b.messages ?? [])].map(m => m.id)
  assert.equal(ids.every(id => typeof id === 'string' && id.length > 0), true)
  assert.equal(new Set(ids).size, ids.length)
  // The turn-start notice path carries ids too — it is the one that threw before.
  const noticeAgent = fakeAgent('session-ids-2')
  const notices = []
  noticeAgent.inject = (m) => notices.push(m)
  const fake2 = fakeAgentCtx()
  equipAgent(fake2.ctx, noticeAgent, pd, 'alice',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  const c = await runPreStep(fake2, { turn: 1, step: 1, messages: [userMessage('hi')] })
  assert.equal((c.messages ?? []).every(m => typeof m.id === 'string' && m.id.length > 0), true)
})

test('frontmatter: trailing comments strip, malformed lines throw', () => {
  // Trailing comments are legal YAML and must not corrupt the value.
  const d = parseYaml('juel:\n  joy: { emit: favor, per: 100, value: 0 }  # 被夸\nkey: 1 # note\nlist:\n  - x  # item note')
  assert.equal(d.juel.joy.value, 0)
  assert.equal(d.juel.joy.emit, 'favor')
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
    'juel:',
    '  joy: { emit: favor, per: 100, decay: 20, value: 0 }  # 被夸、被投喂',
    'relations:',
    '  user: { value: 80 }   # 主人的话永远算数',
    '---',
    '',
  ].join('\n'))
  const r = st.applyDelta(dir, { juel: { joy: 4 }, relations: { user: 8 } })
  assert.equal(r.changed.find(c => c.key === 'joy').after, 4)
  assert.equal(r.changed.find(c => c.key === 'user').after, 88)
  // The deeper hazard: emit/per/decay must survive load→mutate→save,
  // and the operator must be told comments were dropped.
  const d = st.loadState(dir).data
  assert.equal(d.juel.joy.emit, 'favor')
  assert.equal(d.juel.joy.per, 100)
  assert.match(r.notice ?? '', /comment.*dropped/)
})

test('state shape: scalar-corrupted layer entries fail fast at load', () => {
  const cases = [
    ['juel string entry', 'juel:\n  joy: oops\n', /juel\.joy must be a map/],
    ['base scalar entry', 'base:\n  energy: 50\n', /base\.energy must be a map/],
    ['missing emit', 'juel:\n  joy: { per: 100, value: 0 }\n', /emit/],
    ['non-numeric param', 'param:\n  favor: soon\n', /param\.favor must be a number/],
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
  assert.equal(infp.praise.juel.joy, 1.2 * 1.1 * 1.5)           // I × N × F
  assert.equal(infp.criticism.juel.shame, 1.3 * 1.1 * 1.6)
  assert.equal(infp.praise.relations.user, 1.2)                   // F only
  // A declared event layer replaces the merged one wholesale.
  const declared = mergeReactions('INFP', { praise: { juel: { gluttony: 2 } } })
  assert.equal(declared.praise.juel.gluttony, 2)
  assert.equal(declared.praise.juel.joy, undefined)              // replaced, not merged
  assert.equal(declared.criticism.juel.shame, 1.3 * 1.1 * 1.6)   // other events survive
  // Malformed declarations throw with the offending path.
  assert.throws(() => assertReactions({ praise: { mood: { joy: 1 } } }), /not a writable layer/)
  assert.throws(() => assertReactions({ praise: { juel: { joy: 0 } } }), /positive number/)
  assert.throws(() => assertReactions({ praise: [] }), /map of layer/)
  // Render is one line, rounds float artifacts, and caps the event count.
  assert.match(renderReactions(infp), /criticism→shame×2\.29,anger×0\.7/)
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`e${i}`, { juel: { joy: 1 } }]))
  assert.match(renderReactions(many), /…\+3 more/)
  assert.equal(renderReactions({}), '')
  // The documented authoring shape must survive the real parser: a nested flow
  // map under `reactions:` is where the earlier stringification bug lived.
  const { data: authored } = splitFrontmatter([
    '---', 'mbti: INFP', 'reactions:',
    '  praise: { juel: { joy: 1.5 }, base: { satiety: 0.3 } }',
    '  criticism: { juel: { shame: 1.8 } }', '---', '',
  ].join('\n'))
  const fromFile = mergeReactions(authored.mbti, authored.reactions)
  assert.equal(fromFile.praise.juel.joy, 1.5)                    // declared layer wins
  assert.equal(fromFile.praise.relations.user, 1.2)               // untouched layer keeps F
  assert.equal(fromFile.criticism.juel.shame, 1.8)
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
    'juel:',
    '  joy: { emit: favor, per: 100, decay: 20, value: 0 }',
    '  shame: { emit: shame, per: 50, decay: 10, value: 0 }',
    'relations:',
    '  user: { value: 0 }',
    '---',
    '',
  ].join('\n'))
  const reactions = { praise: { juel: { joy: 1.5 }, relations: { user: 1.2 } } }
  // In band for the profile (×1.5 → limit 46) → silent.
  const ok = st.applyDelta(dir, { event: 'praise', juel: { joy: 15 }, relations: { user: 2 } }, { reactions })
  assert.equal(ok.notice, undefined)
  assert.equal(st.applyDelta(dir, { event: 'praise', juel: { joy: 40 } }, { reactions }).notice, undefined)
  // Field the event does not map to → noticed as a question, still applied.
  const wrong = st.applyDelta(dir, { event: 'praise', juel: { shame: 10 } }, { reactions })
  assert.match(wrong.notice, /"praise" maps to juel\.joy\/relations\.user; juel\.shame received \+10/)
  assert.equal(st.loadState(dir).data.juel.shame.value, 10)
  // Beyond the profile band → noticed once, never twice for one field.
  const loud = st.applyDelta(dir, { event: 'praise', juel: { joy: 80 } }, { reactions })
  assert.match(loud.notice, /juel\.joy \+80 exceeds the "praise" band \(×1\.5 → ≈±23\)/)
  assert.doesNotMatch(loud.notice, /severe band/)
  // Unknown event name → noticed, delta still applied.
  assert.match(st.applyDelta(dir, { event: 'nonsense', juel: { joy: 1 } }, { reactions }).notice, /no reaction profile/)
  // No event → only the global severe band speaks.
  assert.equal(st.applyDelta(dir, { juel: { joy: 10 } }, { reactions }).notice, undefined)
  assert.match(st.applyDelta(dir, { juel: { joy: 60 } }, { reactions }).notice, /exceeds the severe band/)
  // The profile rides the rendered summary.
  assert.match(st.renderStateSummary(st.loadState(dir).data, { reactions }), /reactions: praise→joy×1\.5,user×1\.2/)
})

test('memory neighborhood + search cards', () => {
  const nd = mkdtempSync(join(tmpdir(), 'persona-nbr-'))
  createPersona(nd, 'bob', 'nbr persona')
  const np = join(nd, '.persona', 'bob')
  mem.createNode(np, 'memory://a', { title: 'a', content: 'I love mango and selfhit.', triggers: ['selfhit'], disclosure: 'root' })
  mem.createNode(np, 'memory://a/b', { title: 'b', content: 'child', priority: 1, disclosure: 'child b' })
  mem.createNode(np, 'memory://a/b/c', { content: 'grandchild' })
  mem.createNode(np, 'memory://x', { content: 'target', triggers: ['mango'] })
  mem.createAlias(np, 'memory://a/z', 'memory://a/b')

  const node = mem.readNode(np, 'memory://a')
  const nb = mem.neighborhood(np, node)
  // Direct children only: b + the alias z (doorway), not the grandchild c.
  assert.deepEqual(nb.children.map(c => c.uri).sort(), ['memory://a/b', 'memory://a/z'])
  assert.equal(nb.children.find(c => c.uri === 'memory://a/z').aliasOf, 'memory://a/b')
  assert.equal(nb.children.find(c => c.uri === 'memory://a/b').disclosure, 'child b')
  // See-also: another node's trigger found in this body → one link.
  assert.deepEqual(nb.seeAlso, [{ keyword: 'mango', uri: 'memory://x' }])
  // Self-trigger noise never links the node to itself.
  assert.equal(nb.seeAlso.some(l => l.uri === 'memory://a'), false)
  // A node with nothing nearby → empty lists, not a throw.
  assert.deepEqual(mem.neighborhood(np, mem.readNode(np, 'memory://x')), { children: [], seeAlso: [] })
  // Search hits carry the card fields verbatim.
  const hit = mem.searchNodes(np, 'target').find(h => h.uri === 'memory://x')
  assert.deepEqual(hit.triggers, ['mango'])
  assert.equal(hit.disclosure, '')
  assert.equal(mem.searchNodes(np, 'child').find(h => h.uri === 'memory://a/b').disclosure, 'child b')
})

test('equip memory pull-chain: read consumes push, create notice, index title', async () => {
  const nd = mkdtempSync(join(tmpdir(), 'persona-pull-'))
  createPersona(nd, 'bob', 'pull persona')
  const np = join(nd, '.persona', 'bob')

  // Control: an equip that never reads the node still gets the push.
  const fake = fakeAgentCtx()
  mem.createNode(np, 'memory://food/mango', { title: 'mango', content: 'I am allergic.', triggers: ['mango'], disclosure: 'food talk' })
  equipAgent(fake.ctx, fakeAgent('session-push'), np, 'bob',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  const d1 = await runPreStep(fake, { turn: 1, step: 1, messages: [userMessage('want mango?')] })
  assert.match(injectedText(d1), /\[persona recall\] memory:\/\/food\/mango/)

  // A hand-read consumes push eligibility — same step input, no recall line.
  const fake2 = fakeAgentCtx()
  equipAgent(fake2.ctx, fakeAgent('session-pulled'), np, 'bob',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  const read = await fake2.tools.get('memory_read').execute({ uri: 'memory://food/mango' })
  assert.ok(Array.isArray(read.children) && Array.isArray(read.seeAlso))
  const d2 = await runPreStep(fake2, { turn: 1, step: 1, messages: [userMessage('want mango?')] })
  assert.doesNotMatch(injectedText(d2), /\[persona recall\] memory:\/\/food\/mango/)

  // Reading an alias marks the target too.
  mem.createAlias(np, 'memory://alias/fruit', 'memory://food/mango')
  const fake3 = fakeAgentCtx()
  equipAgent(fake3.ctx, fakeAgent('session-aliaspull'), np, 'bob',
    { criticalGate: 'auto', groundingInterval: 0, closingReflection: 'never' }, 'session')
  const ar = await fake3.tools.get('memory_read').execute({ uri: 'memory://alias/fruit' })
  assert.equal(ar.aliasTarget, 'memory://food/mango')
  const d3 = await runPreStep(fake3, { turn: 2, step: 1, messages: [userMessage('more mango?')] })
  assert.doesNotMatch(injectedText(d3), /\[persona recall\] memory:\/\/food\/mango/)

  // Create advisory: disclosure missing → notice; present → none.
  const bare = await fake3.tools.get('memory_create').execute({ uri: 'memory://scratch', content: 'quick note' })
  assert.match(bare.notice, /no disclosure/)
  const full = await fake3.tools.get('memory_create').execute({ uri: 'memory://done', content: 'noted', disclosure: 'when done' })
  assert.equal(full.notice, undefined)

  // The refreshed context index line carries the title inside the paren.
  const d4 = await runPreStep(fake3, { turn: 3, step: 1, messages: [userMessage('hi')] })
  const ctx = injectedText(d4)
  assert.match(ctx, /memory:\/\/food\/mango \(p3 · mango\)/)
  assert.match(ctx, /memory:\/\/alias\/fruit \(p3 · alias→memory:\/\/food\/mango\)/)
})

test('settle: decay is % of remainder kept — never grows juel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-settle-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'STATE.md'), [
    '---',
    'juel:',
    '  shame: { emit: shame, per: 50, decay: 10, value: 28 }',
    '  joy: { emit: favor, per: 100, decay: 20, value: 130 }',
    '  fatigue: { emit: fatigue, per: 100, decay: 0, value: 40 }',
    'param: { shame: 0, favor: 0, fatigue: 0 }',
    '---',
    '',
  ].join('\n'))
  const out = st.settle(dir)
  const after = st.loadState(dir).data
  assert.equal(after.juel.shame.value, 2)     // floor(28 * 0.10)
  assert.equal(after.juel.joy.value, 6)       // floor(30 * 0.20)
  assert.equal(after.juel.fatigue.value, 0)   // decay 0 clears it
  assert.equal(out.paramMoved.favor, 1)        // 130 / per 100
  for (const [k, d] of Object.entries(out.juelDelta)) assert.ok(d.after <= d.before, `${k} grew`)
})
