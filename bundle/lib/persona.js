/**
 * Persona library access: `.persona/<name>/` resolution, profile loading,
 * lazy skeleton creation, and the rendered system-prompt text for a persona.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitFrontmatter } from './frontmatter.js'

const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = join(BUNDLE_ROOT, 'templates')
const PROMPTS = join(BUNDLE_ROOT, 'prompts')

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

/** Create a persona archive from templates; fails if it already exists. */
export function createPersona(cwd, name, description = '', libraryDir = '.persona') {
  if (!/^[\w-]+$/.test(name)) throw new Error(`invalid persona name "${name}": use letters, digits, _ or -`)
  if (personaExists(cwd, name, libraryDir)) throw new Error(`persona "${name}" already exists`)
  const dir = ensurePersona(cwd, name, libraryDir)
  writeFileSync(join(dir, 'PERSONA.md'),
    readFileSync(join(TEMPLATES, 'PERSONA.md'), 'utf8')
      .replaceAll('{{name}}', name).replaceAll('{{description}}', description), 'utf8')
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
