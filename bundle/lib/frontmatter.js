/**
 * Minimal YAML frontmatter utilities for persona files.
 * Supports the subset this project writes: scalars, nested maps (2-space indent),
 * block maps of maps, flow maps `{ a: 1 }`, flow/block arrays, and `+N` ints.
 * Not a general YAML parser — authoring stays inside this grammar by contract.
 */

export function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { data: {}, body: text }
  return { data: parseYaml(m[1]), body: m[2] }
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
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].container
    const li = line.match(/^-\s+(.*)$/)
    if (li) {
      if (!Array.isArray(parent)) {
        // convert last key's value into an array
        const holder = stack[stack.length - 1]
        const grand = stack[stack.length - 2]?.container
        if (grand && holder.lastKey !== undefined) {
          const arr = []
          grand[holder.lastKey] = arr
          holder.container = arr
          arr.push(parseScalar(li[1]))
          continue
        }
      }
      parent.push(parseScalar(li[1]))
      continue
    }
    const kv = line.match(/^([^\s:]+):\s*(.*)$/)
    if (!kv) continue
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
  if (s === '') return ''
  if (s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.startsWith('{') && s.endsWith('}')) return parseFlowMap(s)
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(t => parseScalar(t))
  }
  const q = s.match(/^(['"])(.*)\1$/s)
  if (q) return q[2]
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10)
  if (/^[+-]?\d*\.\d+$/.test(s)) return parseFloat(s)
  return s
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
    if (kv) out[kv[1].trim()] = parseScalar(kv[2])
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
