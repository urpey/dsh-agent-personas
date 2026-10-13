/**
 * URI-addressed memory tree over local markdown files.
 *
 * URI `memory://<path>` ↔ `<personaDir>/memory/<path>.md`.
 * A node file carries frontmatter (title/priority/disclosure/triggers/aliasOf)
 * plus markdown content. Aliases are `.md` files whose frontmatter carries
 * `aliasOf: memory://<target>`; reading an alias resolves the target content.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { splitFrontmatter, joinFrontmatter } from './frontmatter.js'

const URI_RE = /^memory:\/\/([^\s]*)$/

export function uriToPath(personaDir, uri) {
  const m = URI_RE.exec(uri)
  if (!m || !m[1] || m[1].includes('..')) throw new Error(`invalid memory uri "${uri}"`)
  return join(personaDir, 'memory', `${m[1]}.md`)
}

export function pathToUri(personaDir, file) {
  const rel = file.slice(join(personaDir, 'memory').length + 1).replace(/\.md$/, '')
  return `memory://${rel}`
}

/** Read one node; resolves aliasOf once. Returns { uri, meta, content, aliasTarget? }. */
export function readNode(personaDir, uri) {
  const file = uriToPath(personaDir, uri)
  if (!existsSync(file)) throw new Error(`no memory at ${uri}`)
  const { data, body } = splitFrontmatter(readFileSync(file, 'utf8'))
  if (data.aliasOf) {
    const target = readNode(personaDir, String(data.aliasOf))
    return { ...target, uri, aliasTarget: String(data.aliasOf),
      priority: data.priority ?? target.priority, disclosure: data.disclosure ?? target.disclosure }
  }
  return { uri, ...data, content: body.trim() }
}

/** Titles are glanceable ENGLISH-ONLY names: [A-Za-z0-9_-]. */
const sanitizeTitle = (t, fallback) => {
  const s = String(t ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return s || String(fallback ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'untitled'
}

export function createNode(personaDir, uri, { title, content, priority = 3, disclosure = '', triggers = [] }) {
  const file = uriToPath(personaDir, uri)
  if (existsSync(file)) throw new Error(`memory already exists at ${uri}`)
  mkdirSync(dirname(file), { recursive: true })
  const t = sanitizeTitle(title, uri.split('/').pop())
  writeFileSync(file, joinFrontmatter(
    { title: t, priority, disclosure, triggers },
    content + '\n'), 'utf8')
  appendIndex(personaDir, uri, t, disclosure)
  return uri
}

export function createAlias(personaDir, uri, targetUri, { priority = 3, disclosure = '' } = {}) {
  readNode(personaDir, targetUri) // ensure target exists
  const file = uriToPath(personaDir, uri)
  if (existsSync(file)) throw new Error(`memory already exists at ${uri}`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, joinFrontmatter({ aliasOf: targetUri, priority, disclosure }, ''), 'utf8')
  appendIndex(personaDir, uri, `alias→${targetUri}`, disclosure)
  return uri
}

export function updateNode(personaDir, uri, { oldString, newString, append, priority, disclosure, addTriggers = [], removeTriggers = [] }) {
  const file = uriToPath(personaDir, uri)
  const node = readNode(personaDir, uri)
  // Content edits must go to the alias's target; the alias file carries no body.
  if (node.aliasTarget && (oldString !== undefined || append !== undefined)) {
    return updateNode(personaDir, node.aliasTarget, { oldString, newString, append })
  }
  const { data, body } = splitFrontmatter(readFileSync(file, 'utf8'))
  let nextBody = body
  if (oldString !== undefined) {
    if (oldString === '') throw new Error('old_string must not be empty')
    // Ellipsis patch: "start...end" replaces from `start` through `end`
    // (inclusive) with newString — mirrors the ellipsis-patch contract.
    const parts = oldString.split(/\.{3}|…/)
    if (parts.length === 2) {
      const [head, tail] = parts
      if (!head || !tail) throw new Error('ellipsis patch needs non-empty anchors')
      const i = nextBody.indexOf(head)
      const j = i < 0 ? -1 : nextBody.indexOf(tail, i + head.length)
      if (i < 0 || j < 0) throw new Error(`ellipsis anchors not found in ${uri}`)
      nextBody = nextBody.slice(0, i) + (newString ?? '') + nextBody.slice(j + tail.length)
    } else {
      if (!nextBody.includes(oldString)) throw new Error(`old_string not found in ${uri}`)
      nextBody = nextBody.replace(oldString, newString ?? '')
    }
  }
  if (append !== undefined) nextBody = nextBody.replace(/\s*$/, '') + '\n' + append + '\n'
  const meta = { ...data }
  if (priority !== undefined) meta.priority = priority
  if (disclosure !== undefined) meta.disclosure = disclosure
  if (addTriggers.length || removeTriggers.length) {
    const cur = new Set(Array.isArray(meta.triggers) ? meta.triggers : [])
    for (const t of addTriggers) cur.add(t)
    for (const t of removeTriggers) cur.delete(t)
    meta.triggers = [...cur]
  }
  writeFileSync(file, joinFrontmatter(meta, nextBody), 'utf8')
}

/**
 * Replace a node's body and/or its whole frontmatter field set in one write.
 *
 * `updateNode` is a patch channel: it needs an anchor to edit text, and it can
 * only add/remove triggers, never SET the exact list. A merge has neither a
 * stable anchor nor an incremental trigger edit — it produces a new body and a
 * new field set outright — so it writes through here instead of guessing a
 * patch that would fail on the first reworded sentence.
 *
 * Content always lands on the canonical node: an alias carries no body, so a
 * rewrite addressed to one redirects to its target.
 *
 * @param personaDir - persona archive root.
 * @param uri - `memory://` path to rewrite.
 * @param fields - body and any frontmatter fields to replace.
 * @returns the canonical URI that was actually written.
 */
export function rewriteNode(personaDir, uri, { content, priority, disclosure, triggers } = {}) {
  const node = readNode(personaDir, uri)
  if (node.aliasTarget) {
    return rewriteNode(personaDir, node.aliasTarget, { content, priority, disclosure, triggers })
  }
  const file = uriToPath(personaDir, uri)
  const { data, body } = splitFrontmatter(readFileSync(file, 'utf8'))
  const meta = { ...data }
  if (priority !== undefined) meta.priority = priority
  if (disclosure !== undefined) meta.disclosure = disclosure
  if (triggers !== undefined) meta.triggers = [...new Set(triggers)]
  const nextBody = content === undefined ? body : `${String(content).trim()}\n`
  writeFileSync(file, joinFrontmatter(meta, nextBody), 'utf8')
  return uri
}

/** The index row for one node, in the exact shape `appendIndex` writes. */
function indexLine(node) {
  const uri = node.uri
  const label = node.aliasOf ? `alias→${node.aliasOf}` : node.title
  return `- [${node.disclosure || 'always'}] ${uri} — ${label}`
}

/**
 * Rebuild MEMORY.md's Index section from the memory tree itself.
 *
 * The Index is derived state — every row is a projection of one node's
 * frontmatter — but it is written incrementally, so an audit that changes a
 * disclosure, merges two nodes, or retires one leaves rows describing a tree
 * that no longer exists. Rebuilding from the tree is the only way the Index and
 * the tree cannot disagree; a per-row patch would have to reimplement the same
 * projection and drift again.
 *
 * The Boot URIs section is left exactly as authored — it is a deliberate
 * choice, not a projection — but boot URIs that no longer resolve are reported,
 * because a boot URI pointing at a retired node loads nothing at session start.
 *
 * @param personaDir - persona archive root.
 * @returns the rebuilt row count and every unresolvable boot URI.
 */
export function syncIndex(personaDir) {
  const file = join(personaDir, 'MEMORY.md')
  if (!existsSync(file)) return { rows: 0, missingBoot: [] }
  const nodes = listNodes(personaDir)
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || a.uri.localeCompare(b.uri))
  const rows = nodes.map(n => indexLine(n))
  const text = readFileSync(file, 'utf8')
  const head = text.split(/^##\s*Index\s*$/m)[0] ?? text
  const next = `${head.replace(/\s*$/, '')}\n\n## Index\n${rows.length ? `${rows.join('\n')}\n` : ''}`
  if (next !== text) writeFileSync(file, next, 'utf8')
  const live = new Set(nodes.map(n => n.uri))
  const missingBoot = bootUris(personaDir).filter(uri => !live.has(uri))
  return { rows: rows.length, missingBoot }
}

/**
 * Adjacency for a node, for the pull chain: direct children (exactly one URI
 * segment deeper, aliases included as doorways) + see-also links (other
 * nodes' trigger words found in this node's content). Links are addresses,
 * not bodies — progressive disclosure stays the model's choice.
 * `node` is the readNode result (uri = the URI asked for; children live under
 * the asked path, so an alias lists its own subtree). Caps bound the result.
 */
const MAX_CHILD_LINES = 10
const MAX_LINK_LINES = 5

export function neighborhood(personaDir, node) {
  const self = node?.uri ?? ''
  const prefix = `${self}/`
  const content = String(node?.content ?? '').toLowerCase()
  const children = []
  const seeAlso = []
  const seenLinks = new Set()
  for (const n of listNodes(personaDir)) {
    if (n.uri.startsWith(prefix) && !n.uri.slice(prefix.length).includes('/')) {
      children.push({
        uri: n.uri, title: n.title, disclosure: n.disclosure,
        priority: n.priority, ...(n.aliasOf ? { aliasOf: n.aliasOf } : {}),
      })
    }
    // see-also: another node's trigger word surfaced inside this body.
    // Skip self (asked URI AND the resolved target), and alias nodes — they
    // carry no body, the canonical URI is the link the model wants.
    if (n.uri === self || n.uri === node?.aliasTarget || n.aliasOf) continue
    for (const t of n.triggers ?? []) {
      const k = String(t ?? '')
      if (!k || seenLinks.has(`${k}|${n.uri}`)) continue
      if (content.includes(k.toLowerCase())) {
        seenLinks.add(`${k}|${n.uri}`)
        seeAlso.push({ keyword: k, uri: n.uri })
      }
    }
  }
  children.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || a.uri.localeCompare(b.uri))
  seeAlso.sort((a, b) => a.keyword.localeCompare(b.keyword) || a.uri.localeCompare(b.uri))
  return { children: children.slice(0, MAX_CHILD_LINES), seeAlso: seeAlso.slice(0, MAX_LINK_LINES) }
}

export function deleteNode(personaDir, uri) {
  const file = uriToPath(personaDir, uri)
  if (!existsSync(file)) throw new Error(`no memory at ${uri}`)
  unlinkSync(file)
  removeIndex(personaDir, uri)
}

/** List all nodes under memory/ with their frontmatter. */
export function listNodes(personaDir) {
  const root = join(personaDir, 'memory')
  if (!existsSync(root)) return []
  const out = []
  walk(root, f => {
    const { data } = splitFrontmatter(readFileSync(f, 'utf8'))
    out.push({ uri: pathToUri(personaDir, f), ...data })
  })
  return out
}

/** Substring search over uri + frontmatter + body. */
export function searchNodes(personaDir, query, limit = 10) {
  const q = query.toLowerCase()
  const hits = []
  const root = join(personaDir, 'memory')
  if (!existsSync(root)) return hits
  walk(root, f => {
    const text = readFileSync(f, 'utf8')
    const { data, body } = splitFrontmatter(text)
    const hay = `${pathToUri(personaDir, f)}\n${JSON.stringify(data)}\n${body}`.toLowerCase()
    if (hay.includes(q)) {
      const idx = body.toLowerCase().indexOf(q)
      hits.push({
        uri: pathToUri(personaDir, f),
        title: data.title,
        disclosure: data.disclosure ?? '',
        triggers: Array.isArray(data.triggers) ? data.triggers : [],
        snippet: idx >= 0 ? body.slice(Math.max(0, idx - 60), idx + 140).trim() : body.slice(0, 140).trim(),
      })
    }
  })
  return hits.slice(0, limit)
}

function walk(dir, visit) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, visit)
    else if (e.name.endsWith('.md')) visit(p)
  }
}

/** Boot URIs from MEMORY.md ("- memory://…" lines under the Boot URIs heading). */
export function bootUris(personaDir) {
  const file = join(personaDir, 'MEMORY.md')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const boot = text.split(/^##\s*Boot URIs\s*$/m)[1]?.split(/^##\s/m)[0] ?? ''
  return [...boot.matchAll(/memory:\/\/[^\s<)]+/g)].map(m => m[0])
}

/** Render boot memories as context text. */
export function renderBoot(personaDir) {
  const uris = bootUris(personaDir)
  const parts = []
  for (const uri of uris) {
    try {
      const node = readNode(personaDir, uri)
      if (!node.aliasTarget) parts.push(`### ${uri}\n${node.content}`)
    } catch { /* missing boot node: skip silently */ }
  }
  return parts.length
    ? `## Boot memory\n\n${parts.join('\n\n')}`
    : ''
}

function appendIndex(personaDir, uri, title, disclosure) {
  const file = join(personaDir, 'MEMORY.md')
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  if (text.includes(uri)) return
  const line = `- [${disclosure || 'always'}] ${uri} — ${title}\n`
  writeFileSync(file, text.replace(/\s*$/, '') + '\n' + line, 'utf8')
}

/**
 * Drop one node's row from the Index section.
 *
 * Scoped to the Index section on purpose: a boot URI is a line that names the
 * same `memory://` path, and a whole-file filter for the URI removes it too —
 * silently un-booting a memory because its node was retired. Retiring a node
 * must not quietly edit a section the operator authored.
 */
function removeIndex(personaDir, uri) {
  const file = join(personaDir, 'MEMORY.md')
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  const parts = text.split(/^(##\s*Index\s*)$/m)
  if (parts.length < 3) return
  const kept = parts[2].split('\n').filter(l => !l.includes(uri))
  writeFileSync(file, parts[0] + parts[1] + kept.join('\n'), 'utf8')
}
