/**
 * Persona library access: `.persona/<name>/` resolution, profile loading,
 * lazy skeleton creation, and the rendered system-prompt text for a persona.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, cpSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitFrontmatter } from './frontmatter.js'

/** Absolute root of this bundle — the base every packaged asset resolves against. */
export const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = join(BUNDLE_ROOT, 'templates')
const PROMPTS = join(BUNDLE_ROOT, 'prompts')
const EXAMPLES = join(BUNDLE_ROOT, 'examples')

export const PROFILE_MARKER = 'persona-profile:'

/** Absolute path of the persona library for a workspace cwd. */
export function libraryRoot(cwd, libraryDir = '.persona') {
  return resolve(cwd, libraryDir)
}

export function personaDir(cwd, name, libraryDir = '.persona') {
  return join(libraryRoot(cwd, libraryDir), name)
}

export function personaExists(cwd, name, libraryDir = '.persona') {
  return existsSync(join(personaDir(cwd, name, libraryDir), 'PERSONA.md'))
}

/** List persona archives in the library. */
export function listPersonas(cwd, libraryDir = '.persona') {
  const root = libraryRoot(cwd, libraryDir)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(root, d.name, 'PERSONA.md')))
    .map(d => {
      const dir = join(root, d.name)
      const { data } = splitFrontmatter(readFileSync(join(dir, 'PERSONA.md'), 'utf8'))
      const memoryDir = join(dir, 'memory')
      return {
        name: d.name,
        description: String(data.description ?? ''),
        hasMemory: existsSync(memoryDir),
        memoryCount: existsSync(memoryDir) ? countFiles(memoryDir) : 0,
      }
    })
}

function countFiles(dir) {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name))
    else if (e.name.endsWith('.md')) n++
  }
  return n
}

/**
 * Ensure a persona archive exists on disk; create missing skeleton lazily.
 * Returns the persona directory path.
 */
export function ensurePersona(cwd, name, libraryDir = '.persona') {
  const dir = personaDir(cwd, name, libraryDir)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  const files = ['PERSONA.md', 'STATE.md', 'MEMORY.md']
  for (const f of files) {
    const target = join(dir, f)
    if (!existsSync(target)) {
      const tpl = readFileSync(join(TEMPLATES, f), 'utf8')
      writeFileSync(target, tpl.replaceAll('{{name}}', name).replaceAll('{{description}}', ''), 'utf8')
    }
  }
  return dir
}

/**
 * List example personas shipped inside the bundle (`bundle/examples/<name>/`).
 * Each is a complete archive — PERSONA/STATE/MEMORY plus its memory tree —
 * meant to be copied into a workspace library by `createPersonaFromExample`.
 */
export function listExamples() {
  if (!existsSync(EXAMPLES)) return []
  return readdirSync(EXAMPLES, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(EXAMPLES, d.name, 'PERSONA.md')))
    .map(d => {
      const { data } = splitFrontmatter(readFileSync(join(EXAMPLES, d.name, 'PERSONA.md'), 'utf8'))
      return { name: d.name, description: String(data.description ?? '') }
    })
}

/** The one owner of "what a persona name may be": the directory name, the
 *  `/persona use <name>` argument and the picker row all read this rule. */
export function assertPersonaName(name) {
  if (typeof name !== 'string' || !/^[\w-]+$/.test(name)) {
    throw new Error(`invalid persona name "${name}": use letters, digits, _ or -`)
  }
}

/** Create a persona archive from templates; fails if it already exists. */
export function createPersona(cwd, name, description = '', libraryDir = '.persona') {
  assertPersonaName(name)
  if (personaExists(cwd, name, libraryDir)) throw new Error(`persona "${name}" already exists`)
  const dir = ensurePersona(cwd, name, libraryDir)
  writeFileSync(join(dir, 'PERSONA.md'),
    readFileSync(join(TEMPLATES, 'PERSONA.md'), 'utf8')
      .replaceAll('{{name}}', name).replaceAll('{{description}}', description), 'utf8')
  return dir
}

/**
 * Copy a bundled example archive (`bundle/examples/<example>/`) into the
 * library as persona `name`; the example keeps its memory tree. The copied
 * PERSONA.md `name:` field is rewritten to the new archive name so frontmatter
 * and directory stay in step. Fails if the persona already exists or the
 * example is unknown.
 */
export function createPersonaFromExample(cwd, name, example, libraryDir = '.persona') {
  assertPersonaName(name)
  assertPersonaName(example)
  if (personaExists(cwd, name, libraryDir)) throw new Error(`persona "${name}" already exists`)
  const source = join(EXAMPLES, example)
  if (!existsSync(join(source, 'PERSONA.md'))) {
    const known = listExamples().map(e => e.name).join(', ') || '(none)'
    throw new Error(`unknown example "${example}" — available: ${known}`)
  }
  const dir = personaDir(cwd, name, libraryDir)
  cpSync(source, dir, { recursive: true })
  const profile = join(dir, 'PERSONA.md')
  const text = readFileSync(profile, 'utf8')
  const renamed = /^name:[^\n]*$/m.test(text)
    ? text.replace(/^name:[^\n]*$/m, `name: ${name}`)
    : text.replace(/^(---\r?\n)/, `$1name: ${name}\n`)
  writeFileSync(profile, renamed, 'utf8')
  return dir
}

/** Archive files `persona_save` may write at the top level of a new archive. */
const ARCHIVE_FILES = new Set(['PERSONA.md', 'STATE.md', 'MEMORY.md'])

/**
 * Accept one `files` key as a path inside the archive, or reject it.
 *
 * `persona_save` creates a skeleton — it is not a general door into `.persona/`.
 * Absolute paths, drive letters, backslashes and `.`/`..` segments are refused
 * before any `join`, so a crafted key cannot address anything outside the
 * archive directory it is creating.
 * @param key - one `files` key from the model.
 * @returns the accepted archive-relative path, or undefined.
 */
function archivePath(key) {
  if (typeof key !== 'string' || key === '') return undefined
  if (key.startsWith('/') || key.startsWith('\\') || /^[A-Za-z]:/.test(key)) return undefined
  if (key.includes('\\')) return undefined
  if (key.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  if (ARCHIVE_FILES.has(key)) return key
  if (!key.startsWith('memory/')) return undefined
  return key.endsWith('.md') ? key : undefined
}

/** The `description:` scalar of a PERSONA.md draft, for template substitution. */
function draftDescription(text) {
  try { return String(splitFrontmatter(text).data.description ?? '') } catch { return '' }
}

/**
 * Create a persona archive from an authored draft: validate everything, then write.
 *
 * This is the ONE channel an agent may use to write `.persona/**` — the file
 * tools are denied there by the equip guard (`lib/equip.js`), so an authoring
 * flow that could not reach this function could not land a persona at all.
 * Creation only: an existing archive is never overwritten, so the persona a
 * session is currently running as cannot be rewritten from under itself.
 *
 * Every check runs before the first `mkdir`, because a half-created archive is
 * worse than a refused one: `listPersonas` would show it, and the author could
 * not tell a partial write from a deliberate one.
 *
 * @param cwd - workspace root.
 * @param name - archive name, `^[\w-]+$`.
 * @param files - archive-relative path → file text.
 * @param libraryDir - library root, relative to cwd.
 * @returns the created persona directory.
 */
export function savePersona(cwd, name, files, libraryDir = '.persona') {
  assertPersonaName(name)
  if (personaExists(cwd, name, libraryDir)) {
    throw new Error(`persona "${name}" already exists — persona_save only creates new archives, it never overwrites`)
  }
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('persona_save requires files: an object mapping archive path to file text')
  }

  const drafts = new Map()
  for (const [key, text] of Object.entries(files)) {
    const path = archivePath(key)
    if (path === undefined) {
      throw new Error(`invalid file path "${key}": use PERSONA.md, STATE.md, MEMORY.md or memory/<name>.md`)
    }
    if (typeof text !== 'string') throw new Error(`file "${key}" must be a string`)
    drafts.set(path, text)
  }
  if (!drafts.has('PERSONA.md')) {
    throw new Error('persona_save requires PERSONA.md — it is the file that makes a directory a persona archive')
  }
  // The structured files carry frontmatter this project parses with a
  // deliberately minimal grammar (`lib/frontmatter.js`). A draft outside that
  // grammar has to fail here, while nothing is written, instead of at the first
  // state or memory write later — by then the archive already looks real.
  for (const file of ['PERSONA.md', 'STATE.md']) {
    const text = drafts.get(file)
    if (text === undefined) continue
    if (!/^---\r?\n/.test(text)) throw new Error(`${file} must open with a --- frontmatter block`)
    try {
      splitFrontmatter(text)
    } catch (e) {
      throw new Error(`${file} frontmatter is not parseable: ${e.message}`)
    }
  }

  const dir = personaDir(cwd, name, libraryDir)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  // Skeleton completeness is the host's job, not the author's: a draft that
  // omitted STATE.md or MEMORY.md still yields a loadable archive.
  const description = draftDescription(drafts.get('PERSONA.md'))
  for (const file of ARCHIVE_FILES) {
    const text = drafts.get(file) ?? readFileSync(join(TEMPLATES, file), 'utf8')
      .replaceAll('{{name}}', name).replaceAll('{{description}}', description)
    writeFileSync(join(dir, file), text, 'utf8')
  }
  for (const [path, text] of drafts) {
    if (ARCHIVE_FILES.has(path)) continue
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text, 'utf8')
  }
  return dir
}

/** Rendered persona body: PERSONA.md content with frontmatter stripped.
 *  `dir` is the absolute path of `.persona/<name>/` (the persona archive root),
 *  not the workspace cwd — callers that already hold a personaDir must not
 *  double-append the persona name. Frontmatter (name/description/triggers) is
 *  system metadata and never enters the model prompt. */
export function renderPersonaBody(dir, name) {
  const file = join(dir, 'PERSONA.md')
  if (!existsSync(file)) throw new Error(`persona "${name}" not found under ${dir}`)
  const { body } = splitFrontmatter(readFileSync(file, 'utf8'))
  return `${body.trim()}\n`
}

/** Full prefix text for detection channels: `persona-profile:<name>` marker
 *  line + body. The marker is parsed by the persona provider/equip listener;
 *  it is stripped before the text reaches the prompt. */
export function renderPersonaPrefix(dir, name) {
  return `${PROFILE_MARKER}${name}\n\n${renderPersonaBody(dir, name)}`
}

/** Strip the marker line and frontmatter from persona text — the cleaned
 *  prompt-facing version of a `request.persona` payload. */
export function stripPersonaText(text) {
  if (!text) return text
  let t = text.replace(/^persona-profile:[\w-]+\s*\n?/m, '').trimStart()
  if (t.startsWith('---')) {
    // splitFrontmatter anchors `---` at offset 0 — feed it the trimmed text.
    t = splitFrontmatter(t).body
  }
  return `${t.trim()}\n`
}

export function readPromptAsset(name) {
  return readFileSync(join(PROMPTS, name), 'utf8')
}
