/**
 * Minimal YAML frontmatter utilities for persona files.
 * Supports the subset this project writes: scalars, nested maps (2-space indent),
 * block maps of maps, flow maps `{ a: 1 }`, flow/block arrays, and `+N` ints.
 * Trailing `#` comments are stripped (quote-aware); callers get a
 * `droppedComments` count so writers can warn that dumps don't restore them.
 * Malformed lines throw — a value that can't be parsed must never degrade
 * into a silent string, because a later write-back would drop its schema keys.
 * Not a general YAML parser — authoring stays inside this grammar by contract.
 */

export function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { data: {}, body: text }
  const src = m[1]
  const droppedComments = src.split(/\r?\n/).filter(l => {
    const t = l.trim()
    return t !== '' && (t.startsWith('#') || stripComment(t) !== t)
  }).length
  return { data: parseYaml(src), body: m[2], droppedComments }
}

/**
 * Remove a trailing `#` comment: `#` preceded by whitespace (or at index 0),
 * ignoring `#` inside quotes. A `#` mid-token (no space before) is data.
 * Inside a flow collection this truncates it — exactly like real YAML —
 * and the collection then fails as unterminated rather than silently
 * stringifying.
 */
export function stripComment(s) {
  let quote = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote === '"' && ch === '\\') { i++; continue }
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

export function joinFrontmatter(data, body) {
  const yaml = dumpYaml(data).trimEnd()
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`
}

// ---------------------------------------------------------------- parse ----

export function parseYaml(src) {
  const lines = src.split(/\r?\n/)
  const root = {}
  // stack: [{ indent, container }]
  const stack = [{ indent: -1, container: root }]
  for (const raw of lines) {
    const line = stripComment(raw.trim())
    if (line === '') continue
    const indent = raw.length - raw.trimStart().length
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].container
    const bare = line === '-'
    const li = bare ? undefined : line.match(/^-\s+(.*)$/)?.[1]
    if (bare || li !== undefined) {
      const item = bare ? null : parseScalar(li)
      if (!Array.isArray(parent)) {
        // convert last key's value into an array
        const holder = stack[stack.length - 1]
        const grand = stack[stack.length - 2]?.container
        if (grand && holder.lastKey !== undefined) {
          const arr = []
          grand[holder.lastKey] = arr
          holder.container = arr
          arr.push(item)
          continue
        }
      }
      parent.push(item)
      continue
    }
    const kv = line.match(/^([^\s:]+):\s*(.*)$/)
    if (!kv) throw new Error(`frontmatter line not parseable: ${line}`)
    const [, key, rest] = kv
    if (rest === '') {
      // nested container; decide array vs map on next child line — store map, mark key
      const child = {}
      parent[key] = child
      stack.push({ indent, container: child, lastKey: key })
    } else {
      parent[key] = parseScalar(rest)
      stack[stack.length - 1].lastKey = key
    }
  }
  return root
}

function parseScalar(s) {
  s = s.trim()
  if (s === '') return null
  if (s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.startsWith('{') || s.startsWith('[')) {
    const close = s.startsWith('{') ? '}' : ']'
    if (!s.endsWith(close)) {
      // A comment inside the brackets truncates this scalar (real YAML does
      // the same) — but silently stringifying the fragment corrupts the
      // layer entry, so it must be loud.
      throw new Error(`unterminated flow collection in scalar: ${s}`)
    }
    return s.startsWith('{')
      ? parseFlowMap(s)
      : parseFlowArray(s)
  }
  const q = s.match(/^(['"])(.*)\1$/s)
  if (q) return q[2]
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10)
  if (/^[+-]?\d*\.\d+$/.test(s)) return parseFloat(s)
  return s
}

function parseFlowArray(s) {
  const inner = s.slice(1, -1).trim()
  if (!inner) return []
  return inner.split(',').map(t => parseScalar(t))
}

function parseFlowMap(s) {
  const inner = s.slice(1, -1).trim()
  const out = {}
  if (!inner) return out
  // split on commas not inside braces
  let depth = 0, cur = '', parts = []
  for (const ch of inner) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  if (cur) parts.push(cur)
  for (const part of parts) {
    const kv = part.match(/^\s*([^:]+):\s*(.*)$/)
    if (!kv) throw new Error(`flow map entry missing ':' in ${s}`)
    out[kv[1].trim()] = parseScalar(kv[2])
  }
  return out
}

// ----------------------------------------------------------------- dump ----

export function dumpYaml(data) {
  return dumpValue(data, 0)
}

function dumpValue(v, indent) {
  const pad = '  '.repeat(indent)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return v.map(item =>
      isScalar(item)
        ? `${pad}- ${fmtScalar(item)}`
        : `${pad}- ${dumpFlow(item)}`
    ).join('\n')
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 0) return '{}'
    return keys.map(k => {
      const val = v[k]
      if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length > 0) {
        return `${pad}${k}:\n${dumpValue(val, indent + 1)}`
      }
      if (Array.isArray(val)) {
        if (val.length === 0) return `${pad}${k}: []`
        return `${pad}${k}:\n${dumpValue(val, indent + 1)}`
      }
      return `${pad}${k}: ${fmtScalar(val)}`
    }).join('\n')
  }
  return `${pad}${fmtScalar(v)}`
}

function isScalar(v) {
  return v === null || typeof v !== 'object'
}

function dumpFlow(obj) {
  if (Array.isArray(obj)) return `[${obj.map(fmtScalar).join(', ')}]`
  const inner = Object.entries(obj).map(([k, v]) =>
    `${k}: ${v && typeof v === 'object' ? dumpFlow(v) : fmtScalar(v)}`
  ).join(', ')
  return `{ ${inner} }`
}

function fmtScalar(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' && v >= 0) return `+${v}` === String(v) ? String(v) : String(v)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return String(v)
  const s = String(v)
  return /^[\w一-龥+.-]+$/.test(s) && !/^(null|true|false|~)$/.test(s) ? s : JSON.stringify(s)
}
