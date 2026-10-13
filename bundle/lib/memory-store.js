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

export function createNode(personaDir, uri, { title, content, priority = 3, disclosure = '', triggers = [] }) {
  const file = uriToPath(personaDir, uri)
  if (existsSync(file)) throw new Error(`memory already exists at ${uri}`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, joinFrontmatter(
    { title: title ?? uri.split('/').pop(), priority, disclosure, triggers },
    content + '\n'), 'utf8')
  appendIndex(personaDir, uri, title ?? '', disclosure)
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
    if (!nextBody.includes(oldString)) throw new Error(`old_string not found in ${uri}`)
    nextBody = nextBody.replace(oldString, newString ?? '')
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

function removeIndex(personaDir, uri) {
  const file = join(personaDir, 'MEMORY.md')
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.split('\n').filter(l => !l.includes(uri)).join('\n'), 'utf8')
}
