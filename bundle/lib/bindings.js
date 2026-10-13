/**
 * Session→persona binding ledger: `<libraryRoot>/.bindings/<sessionId>.json`.
 *
 * Why files, not a session event: a live `Session.append` cannot mark an
 * event `ignorable: true`, so an out-of-tree event type (e.g. `persona/bound`)
 * is persisted as a required unknown and makes the whole session log refuse to
 * restore (`validateStoredEvents`). A sidecar file keeps bindings workspace-
 * local, restart-safe, and free of session-vocabulary constraints.
 *
 * Stale entries are self-healing: a binding for a session that never resumes
 * simply never matches; a binding for a deleted persona is cleared on read
 * failure at resume time.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BINDINGS_DIR = '.bindings'

function bindingsRoot(libraryRoot) {
  return join(libraryRoot, BINDINGS_DIR)
}

function bindingPath(libraryRoot, sessionId) {
  return join(bindingsRoot(libraryRoot), `${sessionId}.json`)
}

/**
 * Read the persona name bound to a session, or undefined.
 * @param libraryRoot - absolute `.persona/` root.
 * @param sessionId - session header id.
 */
export function readBinding(libraryRoot, sessionId) {
  if (!sessionId) return undefined
  try {
    const parsed = JSON.parse(readFileSync(bindingPath(libraryRoot, sessionId), 'utf8'))
    return typeof parsed?.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Record that a session is persona-equipped. Returns the binding path written.
 * @param libraryRoot - absolute `.persona/` root.
 * @param sessionId - session header id.
 * @param name - persona archive name.
 */
export function writeBinding(libraryRoot, sessionId, name) {
  if (!sessionId) throw new Error('writeBinding requires a session id')
  const path = bindingPath(libraryRoot, sessionId)
  mkdirSync(bindingsRoot(libraryRoot), { recursive: true })
  writeFileSync(path, JSON.stringify({ name, boundAt: Date.now() }) + '\n', 'utf8')
  return path
}

/** Remove a session's binding; no-op when absent. */
export function clearBinding(libraryRoot, sessionId) {
  if (!sessionId) return
  try { rmSync(bindingPath(libraryRoot, sessionId)) } catch { /* absent or unreadable — either way unbound */ }
}
