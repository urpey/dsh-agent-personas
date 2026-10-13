/**
 * Layered integer state over STATE.md.
 *
 * Layers: base (0..max), juel (signed -100..∞ mood water, crystallizes/burns
 * param on settle), param (persistent standing, settle-only),
 * stats/marks (levels 0-15, param-costed), relations (-100..+100, direct
 * delta), buffs (temporary deltas over base/juel).
 *
 * Write access: values/buffs/relations via tools ONLY; schema keys
 * (max, emit, per, decay, requires, level) are never touched by tools.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitFrontmatter, joinFrontmatter } from './frontmatter.js'
import { renderReactions, REACTION_LAYERS, relationStance } from './critical-prompts.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export function loadState(personaDir) {
  const file = join(personaDir, 'STATE.md')
  if (!existsSync(file)) throw new Error(`STATE.md missing under ${personaDir}`)
  const { data, body, droppedComments } = splitFrontmatter(readFileSync(file, 'utf8'))
  validateShape(data, file)
  return { file, data, body, droppedComments }
}

/**
 * Shape invariants for the numeric layers. Checked at load so a hand-edited
 * STATE.md that drifted out of grammar fails loudly HERE — before any
 * mutation — instead of inside applyDelta (cryptic TypeError) or, worse,
 * after a write-back that already dropped emit/per/decay/max/requires.
 */
function validateShape(d, file) {
  const bad = (path, msg) => { throw new Error(`${file}: ${path} ${msg}`) }
  const isMap = v => v && typeof v === 'object' && !Array.isArray(v)
  const isNum = v => typeof v === 'number' && Number.isFinite(v)
  const expectMap = (path, v) => {
    if (!isMap(v)) bad(path, `must be a map like { value: 0 }, got ${typeof v === 'object' && v !== null ? 'array' : JSON.stringify(v)?.slice(0, 80)}`)
  }
  for (const layer of ['base', 'juel', 'stats', 'marks', 'relations']) {
    if (d[layer] === undefined || d[layer] === null) continue
    if (!isMap(d[layer])) bad(layer, 'must be a map of field entries')
    for (const [k, e] of Object.entries(d[layer])) {
      const path = `${layer}.${k}`
      expectMap(path, e)
      if (e.value !== undefined && !isNum(e.value)) bad(`${path}.value`, 'must be a number')
      if (e.max !== undefined && !isNum(e.max)) bad(`${path}.max`, 'must be a number')
      if (layer === 'base' && e.tick !== undefined && !isNum(e.tick)) bad(`${path}.tick`, 'must be a number')
      if (layer === 'base' && e.tick_every !== undefined && !isNum(e.tick_every)) bad(`${path}.tick_every`, 'must be a number')
      if (e.level !== undefined && !isNum(e.level)) bad(`${path}.level`, 'must be a number')
      if (e.requires !== undefined) {
        if (!isMap(e.requires)) bad(`${path}.requires`, 'must be a map of param costs')
        for (const [j, c] of Object.entries(e.requires))
          if (!isNum(c)) bad(`${path}.requires.${j}`, 'must be a number')
      }
      // Missing/wrong emit silently writes param.undefined on settle.
      if (layer === 'juel') {
        if (typeof e.emit !== 'string' || e.emit === '')
          bad(`${path}.emit`, 'must be a non-empty string (the param it crystallizes into)')
        for (const key of ['per', 'decay'])
          if (e[key] !== undefined && !isNum(e[key])) bad(`${path}.${key}`, 'must be a number')
      }
    }
  }
  if (d.param !== undefined && d.param !== null) {
    if (!isMap(d.param)) bad('param', 'must be a map of standing counts')
    for (const [k, v] of Object.entries(d.param))
      if (!isNum(v)) bad(`param.${k}`, 'must be a number')
  }
  if (d.buffs !== undefined && d.buffs !== null) {
    if (!Array.isArray(d.buffs)) bad('buffs', 'must be an array')
    for (const [i, b] of d.buffs.entries())
      if (!isMap(b)) bad(`buffs[${i}]`, 'must be a buff map')
  }
}

function save(state) {
  writeFileSync(state.file, joinFrontmatter(state.data, state.body), 'utf8')
}

/** Tool-call notice: the dump restores structure, never comments. */
const commentNoticeText = st => st.droppedComments > 0
  ? `${st.droppedComments} comment line(s) dropped on write — dump restores structure only; keep field meaning in Notes/PERSONA.md`
  : null

const noticeField = texts => {
  const list = texts.filter(Boolean)
  return list.length ? { notice: list.join(' | ') } : {}
}

const fmtDelta = v => (v > 0 ? `+${v}` : `${v}`)

/**
 * Advisory calibration — never rejects and never rewrites: compare what was
 * applied with the event's reaction profile so drift shows up in the result the
 * model already reads (same turn, no extra request).
 */
function calibrationNotices(event, applied, reactions) {
  const out = []
  const reported = new Set()
  const profile = event ? reactions?.[event] : null
  if (event && !profile) out.push(`event "${event}" has no reaction profile — delta applied uncalibrated`)
  const mapped = profile
    ? REACTION_LAYERS.flatMap(l => Object.keys(profile[l] ?? {}).map(f => `${l}.${f}`))
    : []
  for (const a of applied) {
    if (a.dv === 0) continue
    const path = `${a.layer}.${a.key}`
    const mult = profile?.[a.layer]?.[a.key]
    if (profile && mult === undefined) {
      out.push(`event "${event}" maps to ${mapped.join('/') || '(nothing)'}; ${path} received ${fmtDelta(a.dv)} — intended?`)
      reported.add(path)
      continue
    }
    if (mult !== undefined) {
      const expected = Math.round(15 * mult)
      if (Math.abs(a.dv) > Math.max(30, expected * 2)) {
        out.push(`${path} ${fmtDelta(a.dv)} exceeds the "${event}" band (×${mult} → ≈±${expected})`)
        reported.add(path)
      }
    }
    // The global ceiling speaks only for fields the profile did not already
    // account for — one field must never produce two notices.
    if (!reported.has(path) && Math.abs(a.dv) > 50) {
      out.push(`${path} ${fmtDelta(a.dv)} exceeds the severe band (±50)`)
      reported.add(path)
    }
  }
  return out.slice(0, 3)
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// ---------------------------------------------------------------- delta ----

/** Apply integer deltas. Only base/juel/relations keys are writable. */
export function applyDelta(personaDir, { base = {}, juel = {}, relations = {}, event }, opts = {}) {
  const { reactions = {} } = opts
  const st = loadState(personaDir)
  const d = st.data
  const changed = []
  const applied = []
  for (const [k, dv] of Object.entries(base)) {
    const f = d.base?.[k]
    if (!f) throw new Error(`unknown base field "${k}"`)
    const before = num(f.value)
    const step = Math.trunc(num(dv))
    const after = clamp(before + step, 0, num(f.max ?? 100))
    f.value = after
    changed.push({ layer: 'base', key: k, before, after, clamped: after !== before + step })
    applied.push({ layer: 'base', key: k, dv: step })
  }
  for (const [k, dv] of Object.entries(juel)) {
    const f = d.juel?.[k]
    if (!f) throw new Error(`unknown juel field "${k}"`)
    const before = num(f.value)
    const step = Math.trunc(num(dv))
    // Signed accumulator: a negative balance is banked amends — it burns the
    // emitted param on settle. Floor -100 keeps "juel" a ledger, not a pit.
    const after = clamp(before + step, -100, Infinity)
    f.value = after
    changed.push({ layer: 'juel', key: k, before, after, clamped: after !== before + step })
    applied.push({ layer: 'juel', key: k, dv: step })
  }
  for (const [k, dv] of Object.entries(relations)) {
    d.relations ??= {}
    d.relations[k] ??= { value: 0 }
    const f = d.relations[k]
    const before = num(f.value)
    const step = Math.trunc(num(dv))
    const after = clamp(before + step, -100, 100)
    f.value = after
    changed.push({ layer: 'relations', key: k, before, after, clamped: after !== before + step })
    applied.push({ layer: 'relations', key: k, dv: step })
  }
  save(st)
  return {
    changed,
    effective: renderStateSummary(st.data, { reactions }),
    ...noticeField([...calibrationNotices(event, applied, reactions), commentNoticeText(st)]),
  }
}

// ---------------------------------------------------------------- buffs ----

export function applyBuff(personaDir, { name, domain = 'misc', duration = null, deltas = {} }) {
  if (!name) throw new Error('buff name required')
  const st = loadState(personaDir)
  const d = st.data
  d.buffs ??= []
  const i = d.buffs.findIndex(b => b.name === name)
  const buff = { name, domain, duration: duration === null ? null : Math.trunc(num(duration)), deltas }
  if (i >= 0) d.buffs[i] = buff  // refresh, not stack
  else d.buffs.push(buff)
  save(st)
  return { buff, refreshed: i >= 0, ...noticeField([commentNoticeText(st)]) }
}

export function clearBuffs(personaDir, { name, domain } = {}) {
  const st = loadState(personaDir)
  const d = st.data
  const before = (d.buffs ?? []).length
  if (name === undefined && domain === undefined) d.buffs = []
  else d.buffs = (d.buffs ?? []).filter(b =>
    name !== undefined ? b.name !== name : b.domain !== domain)
  save(st)
  return { removed: before - d.buffs.length, ...noticeField([commentNoticeText(st)]) }
}

/** Decrement turn-based buff durations; returns expired names. Called per turn. */
export function tickBuffs(personaDir) {
  const st = loadState(personaDir)
  const d = st.data
  const expired = []
  const keep = []
  for (const b of d.buffs ?? []) {
    if (b.duration === null || b.duration === undefined) { keep.push(b); continue }
    const left = Math.trunc(num(b.duration)) - 1
    if (left <= 0) expired.push(b.name)
    else keep.push({ ...b, duration: left })
  }
  const changed = expired.length || keep.some((b, i) => b.duration !== (d.buffs ?? [])[i]?.duration)
  if (changed) { d.buffs = keep; save(st) }
  return expired
}

/**
 * Apply each base field's per-turn tick — the body's own clock. `tick_every`
 * spreads a tick over N turns (`tick: -1, tick_every: 2` = -1 every second
 * turn), decided by the session's 1-based turn number, so the cadence needs no
 * stored phase and survives a restart. Called without a turn number the tick
 * applies on every call (direct tooling/tests). Only saves when something
 * actually moved, so an idle turn never rewrites the file (and never drops its
 * comments). Returns the applied drifts.
 */
export function tickBase(personaDir, { turn } = {}) {
  const st = loadState(personaDir)
  const d = st.data
  const drifts = []
  for (const [k, f] of Object.entries(d.base ?? {})) {
    const tick = Math.trunc(num(f.tick))
    if (!tick) continue
    const every = Math.max(1, Math.trunc(num(f.tick_every ?? 1)))
    if (every > 1 && turn !== undefined && turn % every !== 0) continue
    const before = num(f.value)
    const after = clamp(before + tick, 0, num(f.max ?? 100))
    if (after !== before) {
      f.value = after
      drifts.push({ key: k, before, after, tick, every })
    }
  }
  if (drifts.length) save(st)
  return drifts
}

// ---------------------------------------------------------------- settle ---

/** Crystallize juel → param, then spend param on stats/marks level-ups. */
export function settle(personaDir) {
  const st = loadState(personaDir)
  const d = st.data
  const juelDelta = {}
  const paramMoved = {}
  d.param ??= {}
  for (const [key, p] of Object.entries(d.juel ?? {})) {
    const value = num(p.value)
    const per = Math.max(1, Math.trunc(num(p.per ?? 100)))
    const decay = clamp(num(p.decay ?? 0), 0, 100)
    // Signed crystallization: positive balance emits whole gems
    // (Math.trunc keeps the sign — a negative balance BURNS the emitted
    // param back, i.e. banked amends pay down standing grievance/shame).
    const moved = Math.trunc(value / per)
    const remainder = value - moved * per
    // decay = % of the remainder that SURVIVES the settle (0 clears it,
    // 100 carries it over whole), applied symmetrically toward zero.
    const kept = remainder >= 0
      ? Math.floor(remainder * decay / 100)
      : Math.ceil(remainder * decay / 100)
    if (moved !== 0 || value !== kept) {
      juelDelta[key] = { before: value, after: kept, emitted: moved, param: p.emit }
      if (moved !== 0) {
        // param floors at 0 — burned amends past zero are simply spent
        // goodwill that decays away with the remainder, never a debt.
        const after = Math.max(0, num(d.param[p.emit]) + moved)
        d.param[p.emit] = after
        paramMoved[p.emit] = (paramMoved[p.emit] ?? 0) + moved
      }
      p.value = kept
    }
  }
  const levelUps = []
  for (const kind of ['stats', 'marks']) {
    for (const [key, entry] of Object.entries(d[kind] ?? {})) {
      const level = Math.trunc(num(entry.level))
      const req = entry.requires ?? {}
      if (level >= 15) continue
      const affordable = Object.entries(req).every(([j, cost]) => num(d.param[j]) >= num(cost))
      if (!affordable) continue
      for (const [j, cost] of Object.entries(req)) d.param[j] = num(d.param[j]) - num(cost)
      entry.level = level + 1
      levelUps.push({ kind, key, level: entry.level })
    }
  }
  save(st)
  return { juelDelta, paramMoved, levelUps, param: d.param, ...noticeField([commentNoticeText(st)]) }
}

/** Append free text to the STATE.md body (the only writable prose field). */
export function appendNote(personaDir, text) {
  const st = loadState(personaDir)
  st.body = st.body.replace(/\s*$/, '') + '\n' + text + '\n'
  save(st)
  return { appended: true, ...noticeField([commentNoticeText(st)]) }
}

// ---------------------------------------------------------------- render ---

/** Effective value of a base/juel field including matching buffs. */
export function effectiveValue(d, layer, key) {
  const f = d[layer]?.[key]
  const base = num(f?.value)
  let bonus = 0
  for (const b of d.buffs ?? []) bonus += Math.trunc(num(b.deltas?.[key] ?? 0))
  const max = layer === 'base' ? num(f?.max ?? 100) : Infinity
  return { base, bonus, effective: clamp(base + bonus, 0, max) }
}

export function renderStateSummary(data, { reactions = {} } = {}) {
  const lines = []
  for (const [k, f] of Object.entries(data.base ?? {})) {
    const { base, bonus, effective } = effectiveValue(data, 'base', k)
    const tick = Math.trunc(num(f.tick))
    const every = Math.max(1, Math.trunc(num(f.tick_every ?? 1)))
    const parts = [
      bonus ? `${base}${bonus >= 0 ? '+' : ''}${bonus}` : '',
      tick ? `${tick > 0 ? '+' : ''}${tick}/${every > 1 ? `${every}t` : 't'}` : '',
    ].filter(Boolean)
    lines.push(`${k}: ${effective}/${f.max ?? 100}` + (parts.length ? ` (${parts.join(', ')})` : ''))
  }
  const juel = Object.entries(data.juel ?? {}).map(([k, f]) => `${k} ${num(f.value)}`).join(' · ')
  if (juel) lines.push(`juel: ${juel}`)
  const rel = Object.entries(data.relations ?? {}).map(([k, f]) => {
    const v = num(f.value)
    const s = relationStance(v)
    return `${k} ${v >= 0 ? '+' : ''}${v} (${s.label} — ${s.hint})`
  }).join(' · ')
  if (rel) lines.push(`relations: ${rel}`)
  // `param` is crystallized standing, not a mood gauge: it outlives the juel
  // that produced it, so the line says what it is rather than leaving the model
  // to guess whether `defiance×60` is a current feeling or a settled one.
  const param = Object.entries(data.param ?? {}).filter(([, v]) => num(v) > 0).map(([k, v]) => `${k}×${v}`).join(' ')
  if (param) lines.push(`param (standing, settle-only): ${param}`)
  const grown = []
  for (const kind of ['stats', 'marks'])
    for (const [k, e] of Object.entries(data[kind] ?? {})) if (num(e.level) > 0) grown.push(`${k} Lv${e.level}`)
  if (grown.length) lines.push(`grown: ${grown.join(' · ')}`)
  const buffs = (data.buffs ?? []).map(b =>
    `${b.name} (${b.domain}${b.duration === null || b.duration === undefined ? '' : `, ${b.duration}t`}): ${Object.entries(b.deltas ?? {}).map(([k, v]) => `${k}${v >= 0 ? '+' : ''}${v}`).join(' ')}`)
  if (buffs.length) lines.push(`buffs: ${buffs.join(' | ')}`)
  if (Object.keys(reactions).length) lines.push(`reactions: ${renderReactions(reactions)}`)
  return lines.join('\n')
}
