/**
 * layered integer state over STATE.md.
 *
 * Layers: base (0..max), palam (>=0 unbounded → juel on settle),
 * juel (permanent, settle-only), stats/marks (levels 0-15, juel-costed),
 * relations (-100..+100, direct delta), buffs (temporary deltas over base/palam).
 *
 * Write access: values/buffs/relations via tools ONLY; schema keys
 * (max, emit, per, decay, requires, level) are never touched by tools.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitFrontmatter, joinFrontmatter } from './frontmatter.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export function loadState(personaDir) {
  const file = join(personaDir, 'STATE.md')
  if (!existsSync(file)) throw new Error(`STATE.md missing under ${personaDir}`)
  const { data, body } = splitFrontmatter(readFileSync(file, 'utf8'))
  return { file, data, body }
}

function save(state) {
  writeFileSync(state.file, joinFrontmatter(state.data, state.body), 'utf8')
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// ---------------------------------------------------------------- delta ----

/** Apply integer deltas. Only base/palam/relations keys are writable. */
export function applyDelta(personaDir, { base = {}, palam = {}, relations = {} }) {
  const st = loadState(personaDir)
  const d = st.data
  const changed = []
  for (const [k, dv] of Object.entries(base)) {
    const f = d.base?.[k]
    if (!f) throw new Error(`unknown base field "${k}"`)
    const before = num(f.value)
    const after = clamp(before + Math.trunc(num(dv)), 0, num(f.max ?? 100))
    f.value = after
    changed.push({ layer: 'base', key: k, before, after, clamped: after !== before + Math.trunc(num(dv)) })
  }
  for (const [k, dv] of Object.entries(palam)) {
    const f = d.palam?.[k]
    if (!f) throw new Error(`unknown palam field "${k}"`)
    const before = num(f.value)
    const after = Math.max(0, before + Math.trunc(num(dv)))
    f.value = after
    changed.push({ layer: 'palam', key: k, before, after, clamped: after !== before + Math.trunc(num(dv)) })
  }
  for (const [k, dv] of Object.entries(relations)) {
    d.relations ??= {}
    d.relations[k] ??= { value: 0 }
    const f = d.relations[k]
    const before = num(f.value)
    const after = clamp(before + Math.trunc(num(dv)), -100, 100)
    f.value = after
    changed.push({ layer: 'relations', key: k, before, after, clamped: after !== before + Math.trunc(num(dv)) })
  }
  save(st)
  return { changed, effective: renderStateSummary(st.data) }
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
  return { buff, refreshed: i >= 0 }
}

export function clearBuffs(personaDir, { name, domain } = {}) {
  const st = loadState(personaDir)
  const d = st.data
  const before = (d.buffs ?? []).length
  if (name === undefined && domain === undefined) d.buffs = []
  else d.buffs = (d.buffs ?? []).filter(b =>
    name !== undefined ? b.name !== name : b.domain !== domain)
  save(st)
  return { removed: before - d.buffs.length }
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

// ---------------------------------------------------------------- settle ---

/** Crystallize palam → juel, then spend juel on stats/marks level-ups. */
export function settle(personaDir) {
  const st = loadState(personaDir)
  const d = st.data
  const palamDelta = {}
  const juelGained = {}
  d.juel ??= {}
  for (const [key, p] of Object.entries(d.palam ?? {})) {
    const value = num(p.value)
    const per = Math.max(1, Math.trunc(num(p.per ?? 100)))
    const decay = clamp(num(p.decay ?? 0), 0, 100)
    const gain = Math.floor(value / per)
    const remainder = value % per
    const kept = remainder + Math.floor(remainder * (100 - decay) / 100)
    if (gain > 0 || value !== kept) {
      palamDelta[key] = { before: value, after: kept, emitted: gain, juel: p.emit }
      if (gain > 0) {
        d.juel[p.emit] = num(d.juel[p.emit]) + gain
        juelGained[p.emit] = (juelGained[p.emit] ?? 0) + gain
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
      const affordable = Object.entries(req).every(([j, cost]) => num(d.juel[j]) >= num(cost))
      if (!affordable) continue
      for (const [j, cost] of Object.entries(req)) d.juel[j] = num(d.juel[j]) - num(cost)
      entry.level = level + 1
      levelUps.push({ kind, key, level: entry.level })
    }
  }
  save(st)
  return { palamDelta, juelGained, levelUps, juel: d.juel }
}

/** Append free text to the STATE.md body (the only writable prose field). */
export function appendNote(personaDir, text) {
  const st = loadState(personaDir)
  st.body = st.body.replace(/\s*$/, '') + '\n' + text + '\n'
  save(st)
  return { appended: true }
}

// ---------------------------------------------------------------- render ---

/** Effective value of a base/palam field including matching buffs. */
export function effectiveValue(d, layer, key) {
  const f = d[layer]?.[key]
  const base = num(f?.value)
  let bonus = 0
  for (const b of d.buffs ?? []) bonus += Math.trunc(num(b.deltas?.[key] ?? 0))
  const max = layer === 'base' ? num(f?.max ?? 100) : Infinity
  return { base, bonus, effective: clamp(base + bonus, 0, max) }
}

export function renderStateSummary(data) {
  const lines = []
  for (const [k, f] of Object.entries(data.base ?? {})) {
    const { base, bonus, effective } = effectiveValue(data, 'base', k)
    lines.push(`${k}: ${effective}/${f.max ?? 100}` + (bonus ? ` (${base}${bonus >= 0 ? '+' : ''}${bonus})` : ''))
  }
  const palam = Object.entries(data.palam ?? {}).map(([k, f]) => `${k} ${num(f.value)}`).join(' · ')
  if (palam) lines.push(`palam: ${palam}`)
  const rel = Object.entries(data.relations ?? {}).map(([k, f]) => `${k} ${num(f.value) >= 0 ? '+' : ''}${num(f.value)}`).join(' · ')
  if (rel) lines.push(`relations: ${rel}`)
  const juel = Object.entries(data.juel ?? {}).filter(([, v]) => num(v) > 0).map(([k, v]) => `${k}×${v}`).join(' ')
  if (juel) lines.push(`juel: ${juel}`)
  const grown = []
  for (const kind of ['stats', 'marks'])
    for (const [k, e] of Object.entries(data[kind] ?? {})) if (num(e.level) > 0) grown.push(`${k} Lv${e.level}`)
  if (grown.length) lines.push(`grown: ${grown.join(' · ')}`)
  const buffs = (data.buffs ?? []).map(b =>
    `${b.name} (${b.domain}${b.duration === null || b.duration === undefined ? '' : `, ${b.duration}t`}): ${Object.entries(b.deltas ?? {}).map(([k, v]) => `${k}${v >= 0 ? '+' : ''}${v}`).join(' ')}`)
  if (buffs.length) lines.push(`buffs: ${buffs.join(' | ')}`)
  return lines.join('\n')
}
