/**
 * Gate route log: `<libraryRoot>/.routes/<sessionId>.jsonl`, one verdict per line.
 *
 * Why a file, not a session event: the session-append API cannot mark an
 * out-of-tree event type `ignorable: true`, so a `persona/route` record would
 * persist as a required unknown and make the whole session log refuse to
 * restore (`validateStoredEvents`) — the same hazard that keeps bindings in
 * `.bindings/` (see lib/bindings.js, which names the API in its header). The
 * verdict is workspace-local audit data, not session vocabulary, so it must
 * never become a session event.
 *
 * The log is append-only and best-effort: a verdict is worth recording, but
 * never worth failing a turn over, so every failure degrades to `undefined`.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ROUTES_DIR = '.routes'

/**
 * Session id → one filename. The header value is caller-controlled, so the
 * allowed set (`.`) is narrowed further: a dot run survives the character
 * filter (`../../escape` → `.._.._escape`) and would put `..` in the written
 * path. Separators are already replaced, so traversal was never possible; the
 * collapse keeps the *path* honest, not just the containment.
 */
function routeFileName(sessionId) {
  const safe = String(sessionId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._]+/, '')
  return `${safe || 'unknown'}.jsonl`
}

/**
 * Append one verdict line to `<libraryRoot>/.routes/<sessionId>.jsonl`.
 * Never throws: an unwritable log must not break a turn.
 *
 * @param libraryRoot - absolute `.persona/` root (NOT the persona directory).
 * @param sessionId - session header id; missing/unusable ids become `unknown`.
 * @param entry - `{ at, turn, step, verdict, reason, signals }`; `verdict` is
 *                'critical' | 'routine' | 'missed', `signals` may be ''.
 * @returns the path written, or undefined
 */
export function appendRoute(libraryRoot, sessionId, entry) {
  try {
    // Re-created per append: the directory is disposable audit data and may be
    // wiped between turns without warning.
    const root = join(libraryRoot, ROUTES_DIR)
    mkdirSync(root, { recursive: true })
    const path = join(root, routeFileName(sessionId))
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
    return path
  } catch {
    return undefined
  }
}
